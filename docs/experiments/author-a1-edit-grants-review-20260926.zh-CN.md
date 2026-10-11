# A1 候选编辑范围审计

结论：本切片可独立提交。

CandidateWorkspaceManager 将 profile 提供的 repository-relative allowedPaths 转为不可受原数组变更影响的授权副本，支持精确文件与目录 /**。现有固定底座和受保护文件限制继续执行。SkillCandidateFiles 在 write/edit/remove 修改前检查同一授权；最终 preflight/seal 再检查实际 Git diff，因此直接修改工作树不能绕过范围。工作区编辑端口及 Skill overlay 的身份包含授权摘要。

主审阅读工具与封存调用路径，并独立运行 candidate-workspace、skill-files、algorithm-workspace-edit、algorithm-skill-overlay，4 文件 36 项通过。负例覆盖调用方修改授权数组、工具写/编辑/删除越界，以及绕开工具直接修改后无法封存。没有执行真实模型调用。

通用宿主尚须将已解析 profile 的 allowedPaths 传入 manager。此切片只交付执行能力，不把未接线的 profile 宣称为可用。
