// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes";
import * as k8stypes from "@pulumi/kubernetes/types/input";
import * as pulumi from "@pulumi/pulumi";

/**
 * ServiceDeployment is an example abstraction that uses a class to fold together the common pattern of a
 * Kubernetes Deployment and its associated Service object.
 */
export class ServiceDeployment extends pulumi.ComponentResource {
    public readonly deployment: k8s.apps.v1.Deployment;
    public readonly service: k8s.core.v1.Service;
    public readonly serviceMonitor?: k8s.apiextensions.CustomResource;
    public readonly ipAddress?: pulumi.Output<string>;

    constructor(name: string, args: ServiceDeploymentArgs, opts?: pulumi.ComponentResourceOptions) {
        super("k8sjs:service:ServiceDeployment", name, {}, opts);

        const labels = { app: name };
        const container: k8stypes.core.v1.Container = {
            name,
            image: args.image,
            resources: args.resources || { requests: { cpu: "100m", memory: "100Mi" } },
            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
            ports: args.ports && args.ports.map(p => ({ containerPort: p })),
        };
        const containers = [ container ];

        // The exporter runs as a sidecar so it can reach the app on localhost.
        const metrics = args.metrics;
        if (metrics) {
            containers.push({
                name: `${name}-exporter`,
                image: metrics.image,
                args: metrics.args,
                env: metrics.env,
                resources: { requests: { cpu: "10m", memory: "20Mi" } },
                ports: [{ name: "metrics", containerPort: metrics.port }],
            });
        }

        this.deployment = new k8s.apps.v1.Deployment(name, {
            spec: {
                selector: { matchLabels: labels },
                replicas: args.replicas || 1,
                template: {
                    metadata: { labels: labels },
                    spec: { containers: containers },
                },
            },
        }, { parent: this });

        const servicePorts: k8stypes.core.v1.ServicePort[] = (args.ports || []).map(p => ({
            name: `port-${p}`, port: p, targetPort: p,
        }));
        if (metrics) {
            servicePorts.push({ name: "metrics", port: metrics.port, targetPort: "metrics" });
        }

        this.service = new k8s.core.v1.Service(name, {
            metadata: {
                name: name,
                labels: labels,
            },
            spec: {
                ports: servicePorts,
                selector: this.deployment.spec.template.metadata.labels,
                // Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
                // running on minikube, and if so, create only services of type ClusterIP.
                type: args.allocateIpAddress ? (args.isMinikube ? "ClusterIP" : "LoadBalancer") : undefined,
            },
        }, { parent: this });

        // Tells Prometheus to scrape the Service's "metrics" port. The ServiceMonitor CRD comes from the
        // monitoring stack, so it must exist before this resource is created.
        if (metrics) {
            this.serviceMonitor = new k8s.apiextensions.CustomResource(name, {
                apiVersion: "monitoring.coreos.com/v1",
                kind: "ServiceMonitor",
                metadata: { name: name, labels: labels },
                spec: {
                    selector: { matchLabels: labels },
                    endpoints: [{ port: "metrics", interval: "15s" }],
                },
            }, { parent: this, dependsOn: metrics.dependsOn });
        }

        if (args.allocateIpAddress) {
            this.ipAddress = args.isMinikube ?
                this.service.spec.clusterIP :
                this.service.status.loadBalancer.ingress[0].ip;
        }
    }
}

export interface ServiceDeploymentArgs {
    image: string;
    resources?: k8stypes.core.v1.ResourceRequirements;
    replicas?: number;
    ports?: number[];
    allocateIpAddress?: boolean;
    isMinikube?: boolean;
    metrics?: MetricsSidecarArgs;
}

/** A Prometheus exporter that runs next to the app container and is scraped through a ServiceMonitor. */
export interface MetricsSidecarArgs {
    image: string;
    port: number;
    args?: string[];
    env?: k8stypes.core.v1.EnvVar[];
    dependsOn?: pulumi.Resource[];
}
