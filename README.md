# Guestbook with Prometheus and Grafana Monitoring

This project extends the [Pulumi Kubernetes Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook) (the `components` variant) with monitoring. Pulumi deploys Prometheus and Grafana, Prometheus scrapes metrics from the Guestbook frontend and Redis backend, and Grafana shows them on a dashboard that is also defined in code.

Everything is deployed by a single `pulumi up`. Nothing in Grafana or Prometheus is configured by hand.

## Architecture

```
                         ┌──────────────────── namespace: default ────────────────────┐
                         │                                                            │
                         │  frontend pod (x3)        redis-leader pod   redis-replica │
                         │  ┌─────────────────┐      ┌──────────────┐   pod           │
                         │  │ php/apache :80  │      │ redis :6379  │   (same layout) │
                         │  │ apache-exporter │      │ redis-       │                 │
                         │  │ :9117           │      │ exporter     │                 │
                         │  └────────▲────────┘      │ :9121        │                 │
                         │           │               └──────▲───────┘                 │
                         └───────────┼──────────────────────┼─────────────────────────┘
                                     │ ServiceMonitors      │
                         ┌───────────┼──────────────────────┼──── namespace: monitoring ┐
                         │  ┌────────┴──────────────────────┴───┐      ┌─────────────┐  │
  localhost:9090  ───────┼─▶│ Prometheus (scrapes every 15s)    │◀─────│  Grafana    │◀─┼─── localhost:3000
                         │  │ + kube-state-metrics, cAdvisor    │      │  dashboard  │  │
                         │  └───────────────────────────────────┘      └─────────────┘  │
                         └──────────────────────────────────────────────────────────────┘
```

## What was added to the example

| File | Change |
|---|---|
| `monitoring.ts` | New `Monitoring` component. Installs the [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) Helm chart (v92.16.0) with Grafana and Prometheus exposed as NodePort services, and generates the Grafana admin password. |
| `k8sjs.ts` | `ServiceDeployment` accepts an optional `metrics` sidecar. When set, it adds the exporter container, a named `metrics` port on the Service, and a `ServiceMonitor` so Prometheus scrapes it. |
| `index.ts` | Adds a Redis exporter to `redis-leader` and `redis-replica`, an Apache exporter to `frontend`, and exports the Grafana and Prometheus access details. |
| `dashboard.ts` | Defines the Guestbook Grafana dashboard as JSON in a ConfigMap. Grafana's sidecar loads it automatically. |
| `cluster/kind-config.yaml` | A local [kind](https://kind.sigs.k8s.io/) cluster with the Grafana and Prometheus NodePorts mapped to localhost. |

### Metrics collected

| Source | Exporter | Example metrics |
|---|---|---|
| Frontend (Apache + PHP) | [apache_exporter](https://github.com/Lusitaniae/apache_exporter) sidecar reading Apache's `mod_status` page | `apache_accesses_total` (requests), `apache_sent_kilobytes_total`, `apache_workers` |
| Backend (Redis leader and replica) | [redis_exporter](https://github.com/oliver006/redis_exporter) sidecar | `redis_commands_processed_total`, `redis_connected_clients`, `redis_memory_used_bytes` |
| All Guestbook pods | cAdvisor (kubelet), included in kube-prometheus-stack | `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes` |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [Node.js](https://nodejs.org/) 20 or later

Tested with kind v1.37 (Kubernetes v1.37.0), Pulumi v3.272, and Node.js v24.

## Deploy

1. Create the local cluster:

   ```bash
   kind create cluster --config cluster/kind-config.yaml
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a stack. This uses Pulumi's local state backend, so no Pulumi account is needed:

   ```bash
   pulumi login --local
   export PULUMI_CONFIG_PASSPHRASE=""        # PowerShell: $env:PULUMI_CONFIG_PASSPHRASE=""
   pulumi stack init dev
   pulumi config set isMinikube true         # use ClusterIP for the frontend; kind has no LoadBalancer
   ```

4. Deploy:

   ```bash
   pulumi up
   ```

   The first run takes about 2 minutes while the Helm chart installs.

To deploy to a cluster that supports `LoadBalancer` services (EKS, AKS, GKE), set `isMinikube` to `false`. If you're not using kind, reach Grafana through its NodePort (30300) or with `kubectl port-forward`.

## Access Grafana

```bash
pulumi stack output grafanaUrl
pulumi stack output grafanaAdminUser
pulumi stack output grafanaAdminPassword --show-secrets
```

| | |
|---|---|
| URL | http://localhost:3000 |
| Username | `admin` |
| Password | Generated on the first deploy and stored as a Pulumi secret. Run the last command above to show it. |

The password is generated rather than hard-coded, so no credentials are committed to this repository.

Open **Dashboards → Guestbook** to see the dashboard.

## Use the Guestbook and generate traffic

The frontend is a ClusterIP service on kind. Forward it to localhost:

```bash
kubectl port-forward svc/frontend 8080:80
```

Then open http://localhost:8080 and add a few messages. To generate steady traffic for the dashboard, run this in a second terminal:

```bash
for i in $(seq 1 200); do curl -s "http://localhost:8080/guestbook.php?cmd=get&key=messages" > /dev/null; sleep 0.2; done
```

## Verify that Prometheus is scraping the Guestbook

**1. Check the ServiceMonitors exist:**

```bash
kubectl get servicemonitors
```

```
NAME            AGE
frontend        5m
redis-leader    5m
redis-replica   5m
```

**2. Check the scrape targets are up.** On a fresh deploy, allow 1–2 minutes for the Prometheus Operator to pick up the new ServiceMonitors and reload Prometheus. Then open http://localhost:9090/targets and filter for `default`. There should be 5 targets, all in the **UP** state:

- `serviceMonitor/default/frontend/0`: 3 targets, one per frontend pod
- `serviceMonitor/default/redis-leader/0`: 1 target
- `serviceMonitor/default/redis-replica/0`: 1 target

Or check from the command line:

```bash
curl -s 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=up{service=~"frontend|redis-leader|redis-replica"}'
```

Every result should have a value of `"1"`.

**3. Query Guestbook metrics.** Run these at http://localhost:9090/graph:

| Query | Shows |
|---|---|
| `sum(rate(apache_accesses_total[1m]))` | Frontend requests per second |
| `sum by (pod) (apache_accesses_total)` | Total requests handled by each frontend pod |
| `sum by (service) (rate(redis_commands_processed_total[1m]))` | Redis commands per second, leader and replica |
| `sum by (pod) (container_memory_working_set_bytes{namespace="default", container!=""})` | Memory used by each Guestbook pod |

The request counters go up when you use the Guestbook or run the traffic loop above.

## Dashboard

The **Guestbook** dashboard refreshes every 10 seconds and has four rows:

| Row | Panels |
|---|---|
| Overview | Scrape targets up, frontend requests/sec, Redis commands/sec, busy Apache workers |
| Frontend | Request rate by pod, bytes sent by pod |
| Backend | Redis commands/sec and connected clients, leader vs. replica |
| Resources | CPU and memory usage for each Guestbook pod |

## Design decisions

- **Sidecar exporters.** Neither the Guestbook PHP app nor Redis publishes Prometheus metrics. Running an exporter in the same pod lets it reach the app on `localhost`. It also scales with the app: each new frontend replica brings its own exporter, so Prometheus sees every pod individually.
- **Apache `mod_status` stays private.** The frontend image already enables `/server-status`, but only for requests from localhost. The sidecar can read it, while the page itself is never exposed through the Service.
- **ServiceMonitors instead of annotations.** kube-prometheus-stack uses the Prometheus Operator, which discovers targets through ServiceMonitor resources. Prometheus is configured to select ServiceMonitors from every namespace, so the Guestbook needs no Helm-specific labels.
- **Reusable component.** Adding the sidecar, metrics port and ServiceMonitor to `ServiceDeployment` means any future service gets monitoring by passing one `metrics` argument, in keeping with the component approach of the original example.
- **Dashboard as code.** The dashboard is a ConfigMap managed by Pulumi, so it's versioned and recreated with the rest of the stack.
- **Unreachable kind control-plane targets disabled.** etcd, the scheduler, the controller manager and kube-proxy can't be scraped on kind, so they're turned off to keep the targets page free of false failures.

## Limitations and next steps

- **No error-rate metric.** Apache's `mod_status` reports request totals but not HTTP status codes. Measuring 4xx and 5xx rates would need either the app to expose metrics itself, or Apache access logs parsed by something like Loki or mtail.
- **Alerting.** Alertmanager is installed but no Guestbook rules are defined. Good first rules would be a target being down, and Redis replication breaking (`redis_connected_slaves` dropping to 0 on the leader).
- **Persistence.** Prometheus and Grafana use ephemeral storage, which is fine for a demo. In production they'd use persistent volumes.
- **Exposure.** In a real cluster, Grafana would sit behind an Ingress with TLS and SSO rather than a NodePort.

## Clean up

```bash
pulumi destroy
pulumi stack rm dev
kind delete cluster --name guestbook
```

## Project structure

```
.
├── index.ts                  # Guestbook services, exporters, stack outputs
├── k8sjs.ts                  # ServiceDeployment component, with optional metrics sidecar
├── monitoring.ts             # Prometheus + Grafana (kube-prometheus-stack)
├── dashboard.ts              # Grafana dashboard as a ConfigMap
├── cluster/kind-config.yaml  # Local cluster definition
├── Pulumi.yaml
├── package.json
└── tsconfig.json
```
