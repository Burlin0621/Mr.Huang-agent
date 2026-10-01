import { parseSkillZip, type ZipExpertImportResult, type ZipSkillImportResult } from '@/lib/skillhub'
import { useAgentsStore } from '@/stores/agents'
import { useSkillsStore } from '@/stores/skills'

import allPlatformVideoExtractUrl from '@/assets/skillhub/all-platform-video-extract.zip?url'
import designPrdWritingUrl from '@/assets/skillhub/design-prd-writing.zip?url'
import designUiPrototypeUrl from '@/assets/skillhub/design-ui-prototype.zip?url'

/** 内置技能合集包清单（EvoFlow skillhub-expert-package 格式，随应用分发） */
interface BuiltinPackage {
  /** zip 文件名（供 File 构造与日志使用） */
  fileName: string
  /** Vite 静态资源 URL（构建后为带 hash 的产物路径） */
  url: string
}

const BUILTIN_PACKAGES: BuiltinPackage[] = [
  { fileName: 'all-platform-video-extract.zip', url: allPlatformVideoExtractUrl },
  { fileName: 'design-prd-writing.zip', url: designPrdWritingUrl },
  { fileName: 'design-ui-prototype.zip', url: designUiPrototypeUrl },
]

/**
 * 安装单个内置合集包，字段映射与查重规则与 AgentsView 的 expert 导入分支完全一致：
 * - 智能体查重键：`zip:{agent.skillDir}`
 * - 技能查重键：`zip:{agent.skillDir}:{skill.skillKey}`
 * - 智能体已存在则整体跳过该包（与 UI 中「该合集已安装」行为一致）
 */
async function installOnePackage(pkg: BuiltinPackage): Promise<void> {
  const response = await fetch(pkg.url)
  if (!response.ok) {
    console.warn(`[builtin-packages] 拉取内置包失败：${pkg.fileName}（HTTP ${response.status}）`)
    return
  }
  const bytes = await response.arrayBuffer()
  const file = new File([bytes], pkg.fileName)
  const result = await parseSkillZip(file)
  if (result.kind === 'expert') {
    installExpertPackage(result)
    return
  }
  installSkillPackage(result)
}

/** 与 AgentsView 单技能包导入分支相同的写入逻辑：仅写 agents store，查重键 zip:{skillDir} */
function installSkillPackage(parsed: ZipSkillImportResult): void {
  const agentsStore = useAgentsStore()

  const skillhubId = `zip:${parsed.skillDir}`
  if (agentsStore.isSkillhubAdded(skillhubId)) {
    return
  }

  agentsStore.addCustomAgent({
    name: parsed.name,
    description: parsed.description,
    systemPrompt: parsed.systemPrompt,
    icon: '📦',
    tags: ['SkillHub'],
    skillhubId,
  })
}

/** 与 AgentsView.installExpertPackage 相同的写入逻辑（含查重与关联技能 id 收集） */
function installExpertPackage(parsed: ZipExpertImportResult): void {
  const agentsStore = useAgentsStore()
  const skillsStore = useSkillsStore()

  const agentSkillhubId = `zip:${parsed.agent.skillDir}`
  if (agentsStore.isSkillhubAdded(agentSkillhubId)) {
    return
  }

  const linkedSkillIds: string[] = []
  for (const skill of parsed.skills) {
    const skillhubId = `${agentSkillhubId}:${skill.skillKey}`
    if (skillsStore.isSkillImported(skillhubId)) continue
    linkedSkillIds.push(
      skillsStore.addCustomSkill({
        name: skill.name,
        description: skill.description,
        template: skill.template,
        icon: '📚',
        tags: ['SkillHub'],
        skillhubId,
      }),
    )
  }

  agentsStore.addCustomAgent({
    name: parsed.agent.name,
    description: parsed.agent.description,
    systemPrompt: parsed.agent.systemPrompt,
    icon: '📦',
    tags: ['SkillHub'],
    skillhubId: agentSkillhubId,
    linkedSkillIds,
  })
}

/**
 * 应用启动时异步安装内置技能合集包（幂等：已按查重键导入过的包整体跳过）。
 * 单个包失败仅 console.warn，不阻塞应用启动；调用方无需 await（fire-and-forget）。
 */
export function installBuiltinPackages(): void {
  for (const pkg of BUILTIN_PACKAGES) {
    installOnePackage(pkg).catch((error: unknown) => {
      console.warn(`[builtin-packages] 内置包导入失败：${pkg.fileName}`, error)
    })
  }
}
