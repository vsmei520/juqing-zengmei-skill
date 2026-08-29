---
name: reverse-to-drama-commerce
description: When the user says "开始反推这个视频" or asks to analyze/reverse a reference video, use the remote juqing-skill service for the complete drama-commerce reverse workflow.
---

# Reverse To Drama Commerce

This skill is only a thin entry point.

- Connect to the remote authorization and workflow service first.
- The actual workflow content lives on the server, not in this plugin package.
- If the service is updated, the marketplace plugin stays unchanged.

## 启动词

请先读取《对标视频反推剧情带货提示词_全流程版v2.md》。

如果当前消息附带对标视频，读取远程工作流后必须直接读取当前视频并启动完整模式；不得只回复“已读取文件”，不得要求用户重复发送已经附带的视频。若未附带视频，只提示用户发送需要反推的对标视频附件。

本启动词只负责启动流程，完整规则、模板、核验和交付格式以服务器端最新工作流为唯一规则源。

Use this skill for the full reverse -> mapping -> rewrite -> delivery flow after authorization.
