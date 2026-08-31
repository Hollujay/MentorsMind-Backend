import { Request, Response, NextFunction } from "express";
import { CertificationService } from "../services/certification.service";
import { SkillTestService } from "../services/skill-test.service";
import { BackgroundCheckService } from "../services/background-check.service";
import { logger } from "../utils/logger.utils";
import { createError } from "../middleware/errorHandler";

/**
 * Mentor Verification and Certification Controller
 * Handles skill assessments, background checks, and certification badge management
 */
export const MentorVerificationController = {
  /**
   * Get all certification types / available badge tiers
   * GET /api/v1/certifications/types
   */
  async getCertificationTypes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { activeOnly = "true" } = req.query;
      const types = await CertificationService.getCertificationTypes(activeOnly === "true");

      res.status(200).json({
        success: true,
        data: types,
      });
    } catch (error) {
      logger.error("Failed to get certification types in MentorVerificationController", {
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Apply for / create a mentor certification request
   * POST /api/v1/certifications
   */
  async createCertification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { certificationTypeId, verificationMethod, metadata, notes } = req.body;
      const mentorId = (req as any).user?.id;

      if (!mentorId) {
        throw createError("Unauthorized", 401);
      }

      if (!certificationTypeId) {
        throw createError("Certification type ID is required", 400);
      }

      const certification = await CertificationService.createCertification({
        mentorId,
        certificationTypeId,
        verificationMethod,
        metadata,
        notes,
      });

      res.status(201).json({
        success: true,
        data: certification,
      });
    } catch (error) {
      logger.error("Failed to create certification request", {
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Get all certifications for a mentor
   * GET /api/v1/certifications/mentor/:mentorId
   */
  async getMentorCertifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { mentorId } = req.params as Record<string, string>;
      const { includeExpired = "false" } = req.query;

      if ((req as any).user?.role !== "admin" && (req as any).user?.id !== mentorId) {
        throw createError("Access denied", 403);
      }

      const certifications = await CertificationService.getMentorCertifications(
        mentorId,
        includeExpired === "true"
      );

      res.status(200).json({
        success: true,
        data: certifications,
      });
    } catch (error) {
      logger.error("Failed to get mentor certifications", {
        mentorId: req.params.mentorId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Get verified certification badges for a mentor
   * GET /api/v1/certifications/mentor/:mentorId/badges
   */
  async getMentorBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { mentorId } = req.params as Record<string, string>;
      const summary = await CertificationService.getMentorCertificationSummary(mentorId);

      res.status(200).json({
        success: true,
        data: {
          mentorId,
          badges: summary.badges,
          certificationLevel: summary.certificationLevel,
          trustScore: summary.trustScore,
        },
      });
    } catch (error) {
      logger.error("Failed to get mentor badges", {
        mentorId: req.params.mentorId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Get comprehensive certification and verification summary
   * GET /api/v1/certifications/mentor/:mentorId/summary
   */
  async getCertificationSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { mentorId } = req.params as Record<string, string>;
      const summary = await CertificationService.getMentorCertificationSummary(mentorId);

      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (error) {
      logger.error("Failed to get certification summary", {
        mentorId: req.params.mentorId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Start a skill test assessment
   * POST /api/v1/certifications/tests/:testId/start
   */
  async startSkillTest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { testId } = req.params as Record<string, string>;
      const { certificationId } = req.body;
      const mentorId = (req as any).user?.id;

      if (!mentorId) {
        throw createError("Unauthorized", 401);
      }

      const attempt = await SkillTestService.startTestAttempt(
        mentorId,
        testId,
        certificationId
      );

      const questions = await SkillTestService.getTestQuestions(testId, false);

      res.status(201).json({
        success: true,
        data: {
          attempt,
          questions,
        },
      });
    } catch (error) {
      logger.error("Failed to start skill test", {
        testId: req.params.testId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Submit skill assessment answers
   * POST /api/v1/certifications/tests/attempts/:attemptId/submit
   */
  async submitSkillTest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { attemptId } = req.params as Record<string, string>;
      const { answers } = req.body;

      if (!answers) {
        throw createError("Answers are required", 400);
      }

      const result = await SkillTestService.submitTestAnswers({
        attemptId,
        answers,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error("Failed to submit skill test answers", {
        attemptId: req.params.attemptId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Initiate background check verification
   * POST /api/v1/certifications/background-checks
   */
  async initiateBackgroundCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { checkType, provider, certificationId, metadata } = req.body;
      const mentorId = (req as any).user?.id;

      if (!mentorId) {
        throw createError("Unauthorized", 401);
      }

      if (!checkType) {
        throw createError("Background check type is required", 400);
      }

      const check = await BackgroundCheckService.initiateBackgroundCheck({
        mentorId,
        checkType,
        provider,
        certificationId,
        metadata,
      });

      res.status(201).json({
        success: true,
        data: check,
      });
    } catch (error) {
      logger.error("Failed to initiate background check", {
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Get background check verification status
   * GET /api/v1/certifications/background-checks/:checkId
   */
  async getBackgroundCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { checkId } = req.params as Record<string, string>;
      const check = await BackgroundCheckService.getBackgroundCheckById(checkId);

      if (!check) {
        throw createError("Background check not found", 404);
      }

      if ((req as any).user?.role !== "admin" && (req as any).user?.id !== check.mentorId) {
        throw createError("Access denied", 403);
      }

      res.status(200).json({
        success: true,
        data: check,
      });
    } catch (error) {
      logger.error("Failed to get background check", {
        checkId: req.params.checkId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Verify and approve mentor certification (Admin only)
   * POST /api/v1/certifications/:certificationId/verify
   */
  async verifyCertification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { certificationId } = req.params as Record<string, string>;
      const { score, notes } = req.body;
      const verifiedBy = (req as any).user?.id;

      const certification = await CertificationService.updateCertification(
        certificationId,
        {
          status: "verified",
          score,
          notes,
        },
        verifiedBy
      );

      res.status(200).json({
        success: true,
        message: "Certification verified successfully and badge issued",
        data: certification,
      });
    } catch (error) {
      logger.error("Failed to verify certification", {
        certificationId: req.params.certificationId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Revoke mentor certification (Admin only)
   * POST /api/v1/certifications/:certificationId/revoke
   */
  async revokeCertification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { certificationId } = req.params as Record<string, string>;
      const { reason } = req.body;
      const revokedBy = (req as any).user?.id;

      if (!reason) {
        throw createError("Revocation reason is required", 400);
      }

      await CertificationService.revokeCertification(certificationId, reason, revokedBy);

      res.status(200).json({
        success: true,
        message: "Certification revoked successfully",
      });
    } catch (error) {
      logger.error("Failed to revoke certification", {
        certificationId: req.params.certificationId,
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },

  /**
   * Get pending certifications for admin review
   * GET /api/v1/certifications/pending
   */
  async getPendingCertifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { limit = "50" } = req.query;
      const certifications = await CertificationService.getPendingCertifications(
        parseInt(limit as string, 10) || 50
      );

      res.status(200).json({
        success: true,
        data: certifications,
      });
    } catch (error) {
      logger.error("Failed to get pending certifications", {
        error: error instanceof Error ? error.message : error,
      });
      next(error);
    }
  },
};

export default MentorVerificationController;
