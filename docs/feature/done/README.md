# Completed feature plans

Thư mục này lưu các kế hoạch đã hoàn thành hoặc đã đạt phạm vi MVP được chấp
nhận. Backlog chưa xong và các plan còn residual nằm ở [`../`](../README.md).

| # | Plan | Trạng thái |
| --- | --- | --- |
| 01 | [Workflow triggers](workflow-triggers.md) | Done (webhook/issue residual) |
| 02 | [Provider connection truth](provider-connection-truth.md) | Done (OAuth = plan riêng) |
| 03 | [Workflow step profile binding](workflow-step-profile-binding.md) | Done |
| 04 | [Git workspace](git-workspace.md) | Done/MVP |
| 05 | [Knowledge index](knowledge-index.md) | Done |
| 06 | [Knowledge truncation report](knowledge-truncation-report.md) | Done |
| 07 | [Agent lifecycle](agent-lifecycle.md) | Done |
| 08 | [Terminal log retention](terminal-log-retention.md) | Done |
| 09 | [Workflow metrics delta](workflow-metrics-delta.md) | Done |
| 10 | [Task retry policy](task-retry-policy.md) | Done |
| 11 | [Task AI planner](task-ai-planner.md) | Done |
| 12 | [Structured chat capability](structured-chat-capability.md) | Done |
| 13 | [Workflow schema versioning](workflow-schema-versioning.md) | Done |
| 14 | [Diagnostics tiers](diagnostics-tiers.md) | Done/MVP |
| — | [Hermes Agent gateway provider](hermes-agent-provider.md) | Done |

## Quy tắc lưu trữ

- Chỉ chuyển plan vào đây khi không còn acceptance bắt buộc chưa hoàn thành.
- Plan 01 và 02 vào đây với residual **đã được ghi rõ trong chính plan**: phần còn
  lại của chúng cần hạ tầng app chưa có (inbound HTTP listener) hoặc là một plan
  riêng theo đúng lời plan gốc (OAuth thật), không phải acceptance bị bỏ sót.
- Plan `Partial done`, `Residual`, hoặc còn phase bắt buộc vẫn ở `docs/feature/`.
- Nếu một MVP có phần nâng cao nằm ngoài scope đã chấp nhận, ghi rõ trong plan;
  phần nâng cao mới cần một plan backlog riêng thay vì chuyển file này trở lại.
