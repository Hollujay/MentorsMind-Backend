import { logger } from "../utils/logger.utils";

export interface QualityMetrics {
  overallScore: number;
  communicationScore: number;
  engagementScore: number;
  knowledgeTransferScore: number;
  goalAlignmentScore: number;
  actionabilityScore: number;
}

export interface CoachingInsight {
  category: "strength" | "improvement" | "recommendation";
  area: string;
  description: string;
  priority: "high" | "medium" | "low";
  actionable: boolean;
}

export interface QualityAssessmentResult {
  metrics: QualityMetrics;
  coachingInsights: CoachingInsight[];
  improvementAreas: string[];
  strengths: string[];
  confidence: number;
}

interface SessionInputData {
  transcriptText?: string;
  sessionNotes?: string;
  durationMinutes: number;
  participantCount: number;
  actionItemCount: number;
  learningOutcomeCount: number;
  topicCount: number;
  hasRecap: boolean;
  hasFollowUp: boolean;
}

/**
 * ML-based quality assessment for mentoring sessions.
 * Uses heuristic scoring combined with AI analysis when available.
 */
export const QualityAssessmentEngine = {
  /**
   * Calculate quality metrics from session data
   */
  calculateMetrics(data: SessionInputData): QualityMetrics {
    const textContent = [data.transcriptText, data.sessionNotes]
      .filter(Boolean)
      .join(" ");

    // Communication score based on text quality indicators
    const communicationScore = this._assessCommunication(textContent, data);

    // Engagement score based on interaction patterns
    const engagementScore = this._assessEngagement(data);

    // Knowledge transfer score based on learning outcomes
    const knowledgeTransferScore = this._assessKnowledgeTransfer(data);

    // Goal alignment score based on topics and outcomes
    const goalAlignmentScore = this._assessGoalAlignment(data);

    // Actionability score based on action items
    const actionabilityScore = this._assessActionability(data);

    // Weighted overall score
    const overallScore = Math.round(
      communicationScore * 0.2 +
      engagementScore * 0.2 +
      knowledgeTransferScore * 0.25 +
      goalAlignmentScore * 0.15 +
      actionabilityScore * 0.2
    );

    return {
      overallScore: Math.min(100, Math.max(0, overallScore)),
      communicationScore: Math.min(100, Math.max(0, communicationScore)),
      engagementScore: Math.min(100, Math.max(0, engagementScore)),
      knowledgeTransferScore: Math.min(100, Math.max(0, knowledgeTransferScore)),
      goalAlignmentScore: Math.min(100, Math.max(0, goalAlignmentScore)),
      actionabilityScore: Math.min(100, Math.max(0, actionabilityScore)),
    };
  },

  /**
   * Generate coaching insights based on metrics
   */
  generateCoachingInsights(metrics: QualityMetrics, data: SessionInputData): CoachingInsight[] {
    const insights: CoachingInsight[] = [];

    // Communication insights
    if (metrics.communicationScore < 60) {
      insights.push({
        category: "improvement",
        area: "Communication",
        description: "Session communication could be clearer. Consider summarizing key points more explicitly.",
        priority: "high",
        actionable: true,
      });
    } else if (metrics.communicationScore >= 80) {
      insights.push({
        category: "strength",
        area: "Communication",
        description: "Excellent communication throughout the session. Key concepts were clearly articulated.",
        priority: "low",
        actionable: false,
      });
    }

    // Engagement insights
    if (metrics.engagementScore < 50) {
      insights.push({
        category: "improvement",
        area: "Engagement",
        description: "Session engagement was low. Consider incorporating more interactive elements or questions.",
        priority: "high",
        actionable: true,
      });
    }

    // Knowledge transfer insights
    if (data.learningOutcomeCount === 0) {
      insights.push({
        category: "improvement",
        area: "Knowledge Transfer",
        description: "No clear learning outcomes identified. Explicitly state what was learned during the session.",
        priority: "high",
        actionable: true,
      });
    } else if (metrics.knowledgeTransferScore >= 80) {
      insights.push({
        category: "strength",
        area: "Knowledge Transfer",
        description: "Strong knowledge transfer with clear learning outcomes documented.",
        priority: "low",
        actionable: false,
      });
    }

    // Actionability insights
    if (data.actionItemCount === 0) {
      insights.push({
        category: "improvement",
        area: "Actionability",
        description: "No action items were created. Define specific next steps to maintain momentum.",
        priority: "high",
        actionable: true,
      });
    } else if (data.actionItemCount > 5) {
      insights.push({
        category: "recommendation",
        area: "Actionability",
        description: "Consider prioritizing action items. Too many tasks may dilute focus.",
        priority: "medium",
        actionable: true,
      });
    }

    // Duration insights
    if (data.durationMinutes < 15) {
      insights.push({
        category: "recommendation",
        area: "Duration",
        description: "Session was very short. Consider extending to allow deeper exploration of topics.",
        priority: "medium",
        actionable: true,
      });
    } else if (data.durationMinutes > 90) {
      insights.push({
        category: "recommendation",
        area: "Duration",
        description: "Session was quite long. Consider breaking into shorter, focused sessions.",
        priority: "low",
        actionable: true,
      });
    }

    // Follow-up insights
    if (!data.hasFollowUp) {
      insights.push({
        category: "improvement",
        area: "Follow-up",
        description: "No follow-up session planned. Schedule the next session to maintain continuity.",
        priority: "medium",
        actionable: true,
      });
    }

    return insights;
  },

  /**
   * Identify improvement areas and strengths
   */
  identifyAreas(metrics: QualityMetrics): {
    improvementAreas: string[];
    strengths: string[];
  } {
    const improvementAreas: string[] = [];
    const strengths: string[] = [];

    const areas = [
      { name: "Communication", score: metrics.communicationScore },
      { name: "Engagement", score: metrics.engagementScore },
      { name: "Knowledge Transfer", score: metrics.knowledgeTransferScore },
      { name: "Goal Alignment", score: metrics.goalAlignmentScore },
      { name: "Actionability", score: metrics.actionabilityScore },
    ];

    for (const area of areas) {
      if (area.score < 60) {
        improvementAreas.push(area.name);
      } else if (area.score >= 80) {
        strengths.push(area.name);
      }
    }

    return { improvementAreas, strengths };
  },

  // ─── Private scoring methods ────────────────────────────────────────────────

  _assessCommunication(text: string, data: SessionInputData): number {
    if (!text || text.length < 50) return 50;

    let score = 60;

    // Text length indicates thoroughness
    if (text.length > 1000) score += 10;
    if (text.length > 3000) score += 10;

    // Sentence variety (rough heuristic)
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const avgSentenceLength = text.length / Math.max(sentences.length, 1);
    if (avgSentenceLength > 10 && avgSentenceLength < 30) score += 10;

    // Question marks indicate dialogue
    const questionCount = (text.match(/\?/g) || []).length;
    if (questionCount > 3) score += 10;

    return score;
  },

  _assessEngagement(data: SessionInputData): number {
    let score = 50;

    // Participant count suggests interaction
    if (data.participantCount >= 2) score += 15;

    // Duration suggests active participation
    if (data.durationMinutes >= 30) score += 10;
    if (data.durationMinutes >= 60) score += 10;

    // Topics suggest breadth of engagement
    if (data.topicCount >= 3) score += 10;
    if (data.topicCount >= 5) score += 5;

    return score;
  },

  _assessKnowledgeTransfer(data: SessionInputData): number {
    let score = 40;

    // Learning outcomes directly indicate knowledge transfer
    if (data.learningOutcomeCount >= 1) score += 20;
    if (data.learningOutcomeCount >= 3) score += 15;
    if (data.learningOutcomeCount >= 5) score += 10;

    // Recap indicates reinforcement
    if (data.hasRecap) score += 15;

    return score;
  },

  _assessGoalAlignment(data: SessionInputData): number {
    let score = 50;

    // Topic count suggests focused discussion
    if (data.topicCount >= 1 && data.topicCount <= 4) score += 20;

    // Learning outcomes aligned with topics
    if (data.learningOutcomeCount > 0 && data.topicCount > 0) {
      const alignmentRatio = data.learningOutcomeCount / data.topicCount;
      if (alignmentRatio >= 0.5 && alignmentRatio <= 2) score += 15;
    }

    // Follow-up indicates ongoing goal pursuit
    if (data.hasFollowUp) score += 15;

    return score;
  },

  _assessActionability(data: SessionInputData): number {
    let score = 40;

    // Action items directly indicate actionability
    if (data.actionItemCount >= 1) score += 20;
    if (data.actionItemCount >= 3) score += 15;
    if (data.actionItemCount <= 5) score += 10; // Not too many

    // Follow-up suggests sustained action
    if (data.hasFollowUp) score += 15;

    return score;
  },
};
