/**
 * Connection Pool Optimization Configuration
 * Manages intelligent connection pool settings with adaptive sizing
 */

export interface PoolOptimizationConfig {
  // Base pool configuration
  minConnections: number;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  
  // Adaptive sizing configuration
  enableAdaptiveSizing: boolean;
  scaleUpThreshold: number; // Percentage of pool utilization to trigger scale up
  scaleDownThreshold: number; // Percentage of idle connections to trigger scale down
  scaleUpStep: number; // Number of connections to add during scale up
  scaleDownStep: number; // Number of connections to remove during scale down
  evaluationIntervalMs: number; // How often to evaluate pool metrics
  
  // Health monitoring configuration
  healthCheckIntervalMs: number;
  healthCheckTimeoutMs: number;
  maxConnectionAge: number; // Maximum age of a connection before refresh
  failureThreshold: number; // Number of consecutive failures before marking unhealthy
  
  // Failover configuration
  enableFailover: boolean;
  failoverRetries: number;
  failoverDelayMs: number;
  circuitBreakerThreshold: number; // Number of failures before opening circuit
  circuitBreakerResetTimeMs: number;
  
  // Leak detection configuration
  enableLeakDetection: boolean;
  connectionLeakThresholdMs: number; // Time before flagging a connection as potentially leaked
  maxConnectionLifetimeMs: number; // Maximum lifetime before forced release
  
  // Analytics configuration
  enableAnalytics: boolean;
  metricsRetentionMs: number;
  detailedLogging: boolean;
}

export const defaultPoolConfig: PoolOptimizationConfig = {
  minConnections: 5,
  maxConnections: 50,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 10000,
  
  enableAdaptiveSizing: true,
  scaleUpThreshold: 80,
  scaleDownThreshold: 30,
  scaleUpStep: 5,
  scaleDownStep: 2,
  evaluationIntervalMs: 60000,
  
  healthCheckIntervalMs: 30000,
  healthCheckTimeoutMs: 5000,
  maxConnectionAge: 3600000,
  failureThreshold: 3,
  
  enableFailover: true,
  failoverRetries: 3,
  failoverDelayMs: 1000,
  circuitBreakerThreshold: 5,
  circuitBreakerResetTimeMs: 30000,
  
  enableLeakDetection: true,
  connectionLeakThresholdMs: 300000,
  maxConnectionLifetimeMs: 3600000,
  
  enableAnalytics: true,
  metricsRetentionMs: 86400000,
  detailedLogging: false,
};

export interface PoolMetrics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  failedConnections: number;
  averageWaitTimeMs: number;
  averageConnectionTimeMs: number;
  poolUtilization: number;
  timestamp: number;
}

export interface ConnectionHealth {
  connectionId: string;
  isHealthy: boolean;
  lastHealthCheck: number;
  consecutiveFailures: number;
  age: number;
  totalQueries: number;
  lastActivity: number;
}
