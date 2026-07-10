# Đề cương kỹ thuật — Open Data Fusion

Ngày tổng hợp: 10-07-2026. **Open Data Fusion** là một nền tảng mã nguồn mở độc lập, không phải bản sao hay bản tương thích được bảo chứng của Cognite Data Fusion (CDF).

## Phạm vi tham chiếu

CDF công khai mô tả một chuỗi năng lực: tích hợp dữ liệu, biến đổi, contextualization; mô hình dữ liệu property graph; workflows có phiên bản, retry và trigger; pipeline có lịch sử chạy và governance. Các nguồn nền tảng:

- [Data integrations](https://docs.cognite.com/cdf/integration/concepts/about_data_pipelines)
- [Containers, views và data models](https://docs.cognite.com/cdf/dm/dm_concepts/dm_containers_views_datamodels)
- [Contextualization](https://docs.cognite.com/cdf/integration/concepts/contextualization)
- [Data workflows](https://docs.cognite.com/cdf/data_workflows)
- [Extraction pipelines](https://docs.cognite.com/api-reference/concepts/20230101/extraction-pipelines)
- [Cognite Website Terms of Use](https://www.cognite.com/en/company/legal/terms-of-use)

## Định hướng kiến trúc

1. Edge agent/connector chỉ đọc nguồn, đệm cục bộ, gửi outbound mTLS; mọi event có checkpoint, idempotency key và dead-letter queue.
2. Landing bất biến trong object store; transform có version và kiểm thử; data contract tách nguồn, enterprise/canonical và solution view.
3. Semantic core là property graph có node, edge, schema, view và version; mọi thuộc tính/quan hệ giữ provenance, valid time và transaction time.
4. Contextualization tạo **candidate assertion**, không ghi thành fact tin cậy trước khi rule/SME phê duyệt; lưu score, evidence, rule/model version, reviewer và rollback.
5. API-first (REST, GraphQL, event); policy và audit là cross-cutting, không phải chức năng UI cuối dự án.

## Dữ liệu biểu đồ kế hoạch

Điểm dưới đây là **relative engineering effort** do tác giả ước lượng để sắp thứ tự đầu tư, thang 1–5; không phải số liệu đo đạc hay cam kết lịch. Điểm phản ánh độ khó tích hợp, rủi ro vận hành và mức nền tảng cần có.

| Workstream | Effort point | Pha đầu tư | Mô tả |
|---|---:|---|---|
| Foundation, identity, audit | 4 | 0–1 | Kubernetes, OIDC, policy, audit, CI/CD, observability |
| Edge ingestion & landing | 5 | 1 | OPC UA/JDBC/CSV, buffer, raw store, schema checks |
| Model registry & canonical graph | 5 | 2 | spaces, types, views, provenance, query facade |
| Transform & lineage | 4 | 2 | SQL/Spark/dbt-style jobs, quality gates, OpenLineage |
| Explorer/search/time-series UI | 3 | 3 | search, asset graph, chart, document links |
| Contextualization review loop | 4 | 3 | rules, fuzzy match, candidate score, human approval |
| Advanced diagrams/3D/vision | 5 | 5 | P&ID/OCR/3D only after pilot proves core value |

## Guardrails sở hữu trí tuệ và giấy phép

- Không dùng tên/nhãn hiệu CDF, source/binary, SDK package không có license phù hợp, UI, ảnh, text hay hành vi không công khai của Cognite.
- Chỉ dùng tài liệu công khai để xây đặc tả outcome-level; implementation được viết clean-room, có ADR ghi nguồn/decision.
- Own code đề xuất Apache-2.0; mọi dependency phải qua SBOM, SPDX/license scan, NOTICE và security scan trước khi phát hành.
- Tư vấn luật sư về trademark, bằng sáng chế, driver/vender license và nghĩa vụ copyleft trước khi thương mại hóa.

## Chỉ số pilot đề xuất

- Có thể tìm một equipment, xem các time series, document và quan hệ đã được phê duyệt trong một UI/API.
- Hai connector production-like (OPC UA và PostgreSQL/JDBC hoặc CSV), backfill/resume và run history có audit.
- Transform rerun quyết định được; tỷ lệ duplicate write bằng 0 trong bộ test; mỗi field/edge có lineage.
- SSO, RBAC/ABAC theo space/dataset, secret external, audit truy vấn và thay đổi.
- Matching chỉ tự động xuất candidate; quyền approve/reject/rollback tách với quyền ingest.
