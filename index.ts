// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8sjs from "./k8sjs";
import * as pulumi from "@pulumi/pulumi";
import { Monitoring } from "./monitoring";
import { guestbookDashboard } from "./dashboard";

const config = new pulumi.Config();

// NodePorts line up with the host port mappings in cluster/kind-config.yaml.
const monitoring = new Monitoring("monitoring", {
    grafanaNodePort: 30300,
    prometheusNodePort: 30090,
});

// Backend metrics: Redis exporter, which reads INFO from the Redis container over localhost.
const redisMetrics = (): k8sjs.MetricsSidecarArgs => ({
    image: "oliver006/redis_exporter:v1.96.0",
    port: 9121,
    env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
    dependsOn: [monitoring.release],
});

const redisLeader = new k8sjs.ServiceDeployment("redis-leader", {
    image: "redis",
    ports: [6379],
    metrics: redisMetrics(),
});

const redisReplica = new k8sjs.ServiceDeployment("redis-replica", {
    image: "pulumi/guestbook-redis-replica",
    ports: [6379],
    metrics: redisMetrics(),
});

// Frontend metrics: Apache exporter, which reads Apache's mod_status page. The image only allows
// /server-status from localhost, so the sidecar can read it but it is not exposed outside the pod.
const frontend = new k8sjs.ServiceDeployment("frontend", {
    replicas: 3,
    image: "pulumi/guestbook-php-redis",
    ports: [80],
    allocateIpAddress: true,
    isMinikube: config.getBoolean("isMinikube"),
    metrics: {
        image: "lusotycoon/apache-exporter:v1.1.1",
        port: 9117,
        args: ["--scrape_uri=http://localhost/server-status?auto"],
        dependsOn: [monitoring.release],
    },
});

guestbookDashboard(monitoring.namespace.metadata.name, { dependsOn: [monitoring.release] });

export const frontendIp = frontend.ipAddress;

// The NodePorts are mapped to these localhost ports in cluster/kind-config.yaml.
export const grafanaUrl = "http://localhost:3000";
export const grafanaAdminUser = monitoring.grafanaAdminUser;
export const grafanaAdminPassword = pulumi.secret(monitoring.grafanaAdminPassword);
export const prometheusUrl = "http://localhost:9090";
