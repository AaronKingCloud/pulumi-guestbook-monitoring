import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Datasource uid created by kube-prometheus-stack.
const datasource = { type: "prometheus", uid: "prometheus" };

// Pods belonging to the Guestbook, excluding the pause container and pod-level cgroup totals.
const guestbookPods = `namespace="default", pod=~"frontend-.*|redis-.*", container!="", container!="POD"`;

interface PanelSpec {
    title: string;
    type: "timeseries" | "stat";
    exprs: { expr: string; legend?: string }[];
    unit?: string;
    w: number;
    x: number;
    y: number;
}

function panel(id: number, p: PanelSpec) {
    return {
        id,
        title: p.title,
        type: p.type,
        datasource,
        gridPos: { h: p.type === "stat" ? 4 : 8, w: p.w, x: p.x, y: p.y },
        fieldConfig: { defaults: { unit: p.unit || "short" }, overrides: [] },
        options: p.type === "stat" ? { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "value" } : {},
        targets: p.exprs.map((e, i) => ({
            refId: String.fromCharCode(65 + i),
            datasource,
            expr: e.expr,
            legendFormat: e.legend || "__auto",
        })),
    };
}

const panels: PanelSpec[] = [
    // Row 1: headline numbers.
    { title: "Scrape targets up", type: "stat", w: 6, x: 0, y: 0,
      exprs: [{ expr: `count(up{service=~"frontend|redis-leader|redis-replica"} == 1)` }] },
    { title: "Frontend requests/sec", type: "stat", w: 6, x: 6, y: 0, unit: "reqps",
      exprs: [{ expr: `sum(rate(apache_accesses_total[1m]))` }] },
    { title: "Redis commands/sec", type: "stat", w: 6, x: 12, y: 0, unit: "ops",
      exprs: [{ expr: `sum(rate(redis_commands_processed_total[1m]))` }] },
    { title: "Frontend busy workers", type: "stat", w: 6, x: 18, y: 0,
      exprs: [{ expr: `sum(apache_workers{state="busy"})` }] },

    // Row 2: frontend.
    { title: "Frontend request rate by pod", type: "timeseries", w: 12, x: 0, y: 4, unit: "reqps",
      exprs: [{ expr: `sum by (pod) (rate(apache_accesses_total[1m]))`, legend: "{{pod}}" }] },
    { title: "Frontend traffic", type: "timeseries", w: 12, x: 12, y: 4, unit: "Bps",
      exprs: [{ expr: `sum by (pod) (rate(apache_sent_kilobytes_total[1m])) * 1024`, legend: "{{pod}}" }] },

    // Row 3: backend.
    { title: "Redis commands/sec", type: "timeseries", w: 12, x: 0, y: 12, unit: "ops",
      exprs: [{ expr: `sum by (service) (rate(redis_commands_processed_total[1m]))`, legend: "{{service}}" }] },
    { title: "Redis connected clients", type: "timeseries", w: 12, x: 12, y: 12,
      exprs: [{ expr: `sum by (service) (redis_connected_clients)`, legend: "{{service}}" }] },

    // Row 4: resource usage from cAdvisor.
    { title: "Pod CPU usage", type: "timeseries", w: 12, x: 0, y: 20, unit: "cores",
      exprs: [{ expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{${guestbookPods}}[2m]))`, legend: "{{pod}}" }] },
    { title: "Pod memory usage", type: "timeseries", w: 12, x: 12, y: 20, unit: "bytes",
      exprs: [{ expr: `sum by (pod) (container_memory_working_set_bytes{${guestbookPods}})`, legend: "{{pod}}" }] },
];

const dashboard = {
    uid: "guestbook",
    title: "Guestbook",
    tags: ["guestbook"],
    timezone: "browser",
    refresh: "10s",
    time: { from: "now-30m", to: "now" },
    schemaVersion: 39,
    panels: panels.map((p, i) => panel(i + 1, p)),
};

/** Creates the Guestbook dashboard as a ConfigMap that Grafana's sidecar loads automatically. */
export function guestbookDashboard(namespace: pulumi.Input<string>, opts?: pulumi.CustomResourceOptions) {
    return new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            namespace,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook.json": JSON.stringify(dashboard, null, 2) },
    }, opts);
}
