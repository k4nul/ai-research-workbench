import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const projectIntakeSchema = z.object({
  mode: z.enum(["quick", "detailed"]).default("quick"),
  name: z.string().trim().min(3).max(160),
  clientId: z.string().trim().min(1).optional(),
  clientName: z.string().trim().min(2).max(160).optional(),
  coreQuestion: z.string().trim().min(10).max(2_000),
  background: z.string().trim().max(10_000).default(""),
  purpose: z.string().trim().min(3).max(4_000),
  audience: z.string().trim().min(2).max(1_000),
  scope: z.string().trim().min(3).max(10_000),
  exclusions: z.string().trim().max(10_000).default(""),
  jurisdiction: z.string().trim().max(500).default(""),
  researchDate: isoDate,
  sourceMaxAgeDays: z.coerce.number().int().min(0).max(7_300).default(365),
  deadline: isoDate.optional(),
  deliverableFormats: z
    .array(z.enum(["MARKDOWN", "HTML", "PDF", "DOCX", "CSV", "ZIP"]))
    .min(1)
    .max(6)
    .superRefine((formats, context) => {
      const seen = new Set<string>();
      formats.forEach((format, index) => {
        if (seen.has(format)) {
          context.addIssue({
            code: "custom",
            message: "Deliverable formats must be unique.",
            path: [index]
          });
        }
        seen.add(format);
      });
    })
    .default(["MARKDOWN", "HTML", "PDF", "DOCX", "ZIP"]),
  specialRequirements: z.string().trim().max(10_000).default("")
});

export type ProjectIntake = z.infer<typeof projectIntakeSchema>;

export const projectScopeUpdateSchema = projectIntakeSchema
  .pick({
    coreQuestion: true,
    background: true,
    purpose: true,
    audience: true,
    scope: true,
    exclusions: true,
    jurisdiction: true,
    researchDate: true,
    sourceMaxAgeDays: true,
    deadline: true,
    specialRequirements: true
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one scope field to update."
  });

export const sourceInputSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().trim().min(2).max(500),
  publisher: z.string().trim().max(500).optional(),
  author: z.string().trim().max(500).optional(),
  publishedAt: isoDate.optional(),
  sourceType: z.string().trim().min(2).max(80),
  language: z.string().trim().min(2).max(20).default("en"),
  reliabilityGrade: z.enum(["A", "B", "C", "D", "UNRATED"]).default("UNRATED"),
  usageRestrictions: z.string().trim().max(2_000).optional(),
  contentSummary: z.string().trim().max(20_000).optional(),
  sanitizedContent: z.string().max(200_000).optional(),
  ingestionMethod: z
    .enum(["MANUAL", "FETCH", "UPLOAD", "SEARCH", "IMPORT", "REUSE"])
    .default("MANUAL"),
  mimeType: z.string().trim().max(100).optional(),
  reusedFromSourceId: z.string().trim().min(1).optional()
});

export type SourceInput = z.infer<typeof sourceInputSchema>;

export const evidenceInputSchema = z.object({
  sourceId: z.string().trim().min(1),
  summary: z.string().trim().min(3).max(20_000),
  minimalQuote: z.string().trim().max(2_000).optional(),
  originalLocation: z.string().trim().max(1_000).optional(),
  pageOrSection: z.string().trim().max(500).optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  verificationStatus: z.enum(["PENDING", "VERIFIED", "REJECTED"]).default("PENDING"),
  supportExtent: z.enum(["FULL", "PARTIAL"]).default("FULL")
});

export const claimInputSchema = z.object({
  questionId: z.string().trim().min(1).optional(),
  content: z.string().trim().min(3).max(20_000),
  claimType: z.enum(["FACT", "INTERPRETATION", "INFERENCE", "RECOMMENDATION"]),
  importance: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  factOrInference: z.enum(["FACT", "INFERENCE"]),
  verificationPossible: z.boolean().default(true),
  withinScope: z.boolean().default(true),
  includeInReport: z.boolean().default(true),
  resolutionNotes: z.string().trim().max(4_000).optional()
});

export const claimEvidenceLinkSchema = z.object({
  claimId: z.string().trim().min(1),
  evidenceId: z.string().trim().min(1),
  relationship: z.enum(["SUPPORTS", "REFUTES", "CONTEXT"]),
  notes: z.string().trim().max(2_000).optional()
});

export const claimReviewUpdateSchema = z
  .object({
    includeInReport: z.boolean().optional(),
    withinScope: z.boolean().optional(),
    resolutionNotes: z.string().trim().min(3).max(4_000).nullable().optional()
  })
  .refine(
    (value) => value.includeInReport !== undefined || value.withinScope !== undefined || value.resolutionNotes !== undefined,
    { message: "Provide a report-inclusion, scope, or resolution decision." }
  );

export const findingInputSchema = z.object({
  questionId: z.string().trim().min(1).optional(),
  finding: z.string().trim().min(3).max(20_000),
  importance: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  impact: z.string().trim().max(10_000).optional(),
  limitations: z.string().trim().max(10_000).optional(),
  canInformRecommendation: z.boolean().default(false),
  claimIds: z.array(z.string().trim().min(1)).min(1, "Link at least one claim.").max(200)
});

export const reportSectionsSchema = z.object({
  researchPurpose: z.string().max(50_000).default(""),
  executiveSummary: z.string().max(50_000).default(""),
  researchScope: z.string().max(50_000).default(""),
  methodology: z.string().max(50_000).default(""),
  keyFindings: z.string().max(100_000).default(""),
  detailedAnalysis: z.string().max(200_000).default(""),
  comparisonTable: z.string().max(100_000).default(""),
  risksAndLimitations: z.string().max(100_000).default(""),
  recommendations: z.string().max(100_000).default(""),
  references: z.string().max(100_000).default(""),
  appendix: z.string().max(100_000).default("")
});

export type ReportSections = z.infer<typeof reportSectionsSchema>;

export const deliverableUpdateSchema = z.object({
  title: z.string().trim().min(3).max(500),
  sections: reportSectionsSchema,
  actorType: z.enum(["USER", "AI"]).default("USER")
});

export const researchQuestionSchema = z.object({
  parentId: z.string().trim().min(1).optional(),
  question: z.string().trim().min(5).max(4_000),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  completionCriteria: z.string().trim().min(3).max(4_000),
  researchGap: z.string().trim().max(4_000).optional()
});

export const researchPlanSchema = z.object({
  questionId: z.string().trim().min(1),
  searchStrategy: z.string().trim().min(3).max(10_000),
  searchQueries: z.array(z.string().trim().min(1).max(500)).max(30),
  primarySourceTypes: z.array(z.string().trim().min(1).max(100)).max(20),
  secondarySourceTypes: z.array(z.string().trim().min(1).max(100)).max(20),
  comparisonTargets: z.array(z.string().trim().min(1).max(500)).max(20),
  expectedOutput: z.string().trim().min(3).max(4_000),
  completionCondition: z.string().trim().min(3).max(4_000),
  expectedRisks: z.array(z.string().trim().min(1).max(1_000)).max(30),
  researchGap: z.string().trim().max(4_000).optional(),
  aiSuggested: z.boolean().default(false)
});

export const intakeImportSchema = z.object({
  format: z.enum(["json", "markdown"]),
  content: z.string().min(2).max(100_000)
});

export function formatValidationError(error: z.ZodError): {
  code: "VALIDATION_ERROR";
  message: string;
  fields: Record<string, string[]>;
} {
  const flattened = error.flatten();
  return {
    code: "VALIDATION_ERROR",
    message: "The submitted data is invalid.",
    fields: flattened.fieldErrors as Record<string, string[]>
  };
}
