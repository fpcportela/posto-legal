---
name: cloud-cost-optimizer
description: FinOps strategies, serverless cost control, and instance rightsizing.
---

# Skill: Cloud Cost Optimizer (FinOps)

## Principles
1. **Visibility:** Ensure all resources are properly tagged (e.g., Environment, Owner, Service) for granular billing reports.
2. **Rightsizing:** Do not over-provision EC2/VMs. Match compute constraints to actual utilization metrics.
3. **Serverless Limits:** Implement strict concurrency limits and timeout values for AWS Lambda or GCP Cloud Functions to prevent runaway costs from recursive bugs.
4. **Data Transfer Costs:** Keep data processing within the same availability zone where possible; avoid NAT Gateway egress fees for internal traffic.
