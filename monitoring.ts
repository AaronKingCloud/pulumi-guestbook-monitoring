import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

/**
 * Monitoring deploys Prometheus and Grafana using the kube-prometheus-stack Helm chart.
 * Prometheus picks up every ServiceMonitor in the cluster, so the Guestbook only needs to
 * declare its own ServiceMonitors to be scraped.
 */
export class Monitoring extends pulumi.ComponentResource {
    public readonly namespace: k8s.core.v1.Namespace;
    public readonly release: k8s.helm.v3.Release;
    public readonly grafanaAdminUser = "admin";
    public readonly grafanaAdminPassword: pulumi.Output<string>;

    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ComponentResourceOptions) {
        super("guestbook:monitoring:Monitoring", name, {}, opts);

        this.namespace = new k8s.core.v1.Namespace(name, {
            metadata: { name: "monitoring" },
        }, { parent: this });

        // Generated once and kept in the Pulumi state as a secret.
        const password = new random.RandomPassword(`${name}-grafana-admin`, {
            length: 20,
            special: false,
        }, { parent: this });
        this.grafanaAdminPassword = password.result;

        this.release = new k8s.helm.v3.Release(name, {
            name: "kube-prometheus-stack",
            chart: "kube-prometheus-stack",
            version: "92.16.0",
            namespace: this.namespace.metadata.name,
            repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
            values: {
                prometheus: {
                    service: { type: "NodePort", nodePort: args.prometheusNodePort },
                    prometheusSpec: {
                        // Select ServiceMonitors from all namespaces, not only ones labelled for this release.
                        serviceMonitorSelectorNilUsesHelmValues: false,
                        podMonitorSelectorNilUsesHelmValues: false,
                        scrapeInterval: "15s",
                    },
                },
                grafana: {
                    adminUser: this.grafanaAdminUser,
                    adminPassword: password.result,
                    service: { type: "NodePort", nodePort: args.grafanaNodePort },
                    // Load dashboards from ConfigMaps labelled grafana_dashboard=1 in any namespace.
                    sidecar: { dashboards: { enabled: true, label: "grafana_dashboard", searchNamespace: "ALL" } },
                },
                // These control-plane components are not reachable on kind, so their targets would always be down.
                kubeEtcd: { enabled: false },
                kubeControllerManager: { enabled: false },
                kubeScheduler: { enabled: false },
                kubeProxy: { enabled: false },
            },
        }, { parent: this });
    }
}

export interface MonitoringArgs {
    grafanaNodePort: number;
    prometheusNodePort: number;
}
