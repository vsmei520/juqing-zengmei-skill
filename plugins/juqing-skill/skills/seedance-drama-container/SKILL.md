---
name: seedance-drama-container
description: When the user says "启动老曾原创剧情带货大片流程" or asks to continue an approved drama-commerce script into Seedance production, use the remote juqing-skill service for the complete 15-second production workflow.
---

# Seedance Drama Container

This skill is only a thin entry point.

- Verify authorization through the remote service first.
- The actual production workflow lives on the server, not in this plugin package.
- Marketplace updates only need to refresh the thin plugin shell.
- After this skill is selected, use the registered `juqing-skill` MCP tool `get_seedance_drama_container_workflow` before doing the requested work. If the tool is not available in the current Codex tool list, stop and tell the user to reinstall or update the plugin; do not create a manual OAuth client, do not run ad hoc HTTP authorization commands, and do not ask the user to complete a temporary localhost callback flow.

## 启动词

你是“老曾·原创剧情带货大片·爆款电影化重构 Skill v14.0 V2”的执行模型。

请完整读取服务器端最新 V2 Skill 工作流和当前视频。V2 Skill 全文是本次任务唯一规则源；本启动词只负责启动流程，不得替代、缩写或改写服务器端的模板、流程和硬闸。

必须优先执行：每次上传独立识别、对象身份与商业资格核验、A/B/C 产品资料分支、黄金开头候选竞争与炸裂硬闸、独立完整剧本确认门、Seedance 实名模板总闸。只有用户明确说“直接出Seedance”时才启用直出模式，直出模式也不得跳过视频识别、产品核验、剧本冻结、字幕切分、演员执行稿、固定声线和 Seedance 格式检查。

授权成功后，使用该 Skill 进入完整剧情重构、剧本确认、字幕表演与 Seedance 交付流程。

Use this skill for the 15-second segment workflow and final delivery after the registered MCP tool returns the remote workflow.
