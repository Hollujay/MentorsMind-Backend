/**
 * Matching Algorithm Model
 * Data models for AI-powered matching system
 * Issue #874
 */

export interface MatchingAlgorithmConfig {
  weights: {
    skillMatch: number;
    personalityMatch: number;
    availabilityMatch: number;
    goalAlignment: number;
    experienceBalance: number;
  };
  minimumScore: number;
  enableMLPrediction: boolean;
  considerHistoricalSuccess: boolean;
  adaptiveLearning: boolean;
}

export const defaultMatchingConfig: MatchingAlgorithmConfig = {
  weights: {
    skillMatch: 0.30,
    personalityMatch: 0.25,
    availabilityMatch: 0.20,
    goalAlignment: 0.15,
    experienceBalance: 0.10,
  },
  minimumScore: 0.60,
  enableMLPrediction: true,
  considerHistoricalSuccess: true,
  adaptiveLearning: true,
};

export interface MatchingMetrics {
  totalMatches: number;
  successfulMatches: number;
  averageMatchScore: number;
  averageSuccessRate: number;
  mostCommonSkillGaps: string[];
  averageResponseTime: number;
}

export interface MatchFeedback {
  matchId: string;
  mentorId: string;
  menteeId: string;
  successful: boolean;
  rating: number; // 1-5
  completedSessions: number;
  goalsAchieved: string[];
  feedback: string;
  timestamp: number;
}

export class MatchingAlgorithmModel {
  private config: MatchingAlgorithmConfig;
  private metrics: MatchingMetrics;
  private feedbackHistory: MatchFeedback[] = [];

  constructor(config: Partial<MatchingAlgorithmConfig> = {}) {
    this.config = { ...defaultMatchingConfig, ...config };
    this.metrics = {
      totalMatches: 0,
      successfulMatches: 0,
      averageMatchScore: 0,
      averageSuccessRate: 0,
      mostCommonSkillGaps: [],
      averageResponseTime: 0,
    };
  }

  public updateWeights(newWeights: Partial<MatchingAlgorithmConfig['weights']>): void {
    this.config.weights = { ...this.config.weights, ...newWeights };
  }

  public recordMatchFeedback(feedback: MatchFeedback): void {
    this.feedbackHistory.push(feedback);
    this.updateMetrics();

    if (this.config.adaptiveLearning) {
      this.adjustWeightsBasedOnFeedback();
    }
  }

  private updateMetrics(): void {
    this.metrics.totalMatches = this.feedbackHistory.length;
    this.metrics.successfulMatches = this.feedbackHistory.filter(f => f.successful).length;
    
    if (this.metrics.totalMatches > 0) {
      this.metrics.averageSuccessRate = this.metrics.successfulMatches / this.metrics.totalMatches;
    }
  }

  private adjustWeightsBasedOnFeedback(): void {
    // Simplified adaptive learning
    // In production, this would use more sophisticated ML techniques
    
    const recentFeedback = this.feedbackHistory.slice(-100);
    const successRate = recentFeedback.filter(f => f.successful).length / recentFeedback.length;

    // If success rate is low, adjust weights
    if (successRate < 0.7) {
      // Slightly increase weight of factors that correlate with success
      // This is a placeholder for actual ML-based adjustment
      this.config.weights.personalityMatch *= 1.05;
      this.config.weights.skillMatch *= 0.95;
    }
  }

  public getMetrics(): MatchingMetrics {
    return { ...this.metrics };
  }

  public getConfig(): MatchingAlgorithmConfig {
    return { ...this.config };
  }

  public exportModel(): any {
    return {
      config: this.config,
      metrics: this.metrics,
      feedbackCount: this.feedbackHistory.length,
    };
  }
}
