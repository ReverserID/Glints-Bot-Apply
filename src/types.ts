// Types for the parts of the Glints API we touch.
// Captured from the Glints Android app v1.106.2.

export type WorkArrangement = "REMOTE" | "HYBRID" | "ONSITE" | (string & {});
export type JobType = "FULL_TIME" | "PART_TIME" | "CONTRACT" | "FREELANCE" | "INTERNSHIP" | (string & {});
export type EAppPlatform = "ANDROID" | "IOS";
export type UserRole = "CANDIDATE" | "EMPLOYER";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
}

export interface MeFragment {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  gender?: string | null;
  intro?: string | null;
  isVerified: boolean;
  phone?: string | null;
  profilePic?: string | null;
  CountryCode: string;
  age?: number | null;
  birthDate?: string | null;
  careerStartDate?: string | null;
  highestEducationLevel?: string | null;
  resume?: string | null;
  ugcFullName?: string | null;
  LocationId?: string | null;
  role: UserRole;
  applicationsCount: number;
  whatsappNumber?: string | null;
  whatsappLoginNumber?: string | null;
  profileCompletionPercentage: number;
  preferredLocations?: Array<{ latitude: number; longitude: number }>;
  hierarchicalLocation?: {
    id: string;
    name: string;
    formattedName: string;
    countryCode: string;
    level: number;
    parents?: Array<{ id: string; name: string; formattedName: string; level: number }>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface JobSkillRef {
  Skill?: { id: string; name: string };
  skill?: { id: string; name: string };
  mustHave: boolean;
}

export interface JobBenefit {
  id: string;
  benefit: string;
  title: string;
  description?: string;
  logo?: string;
}

export interface JobCompany {
  id: string;
  name: string;
  displayName: string;
  logo?: string | null;
  status?: string;
  isVIP?: boolean;
  industry?: { id?: number; name: string };
}

export interface RecommendedJob {
  id: string;
  title: string;
  status: string;
  type: JobType;
  minYearsOfExperience: number;
  maxYearsOfExperience: number;
  shouldShowSalary: boolean;
  isRemote: boolean;
  workArrangementOption: WorkArrangement;
  isHot: boolean;
  CountryCode: string;
  HierarchicalJobCategoryId?: string;
  externalApplyURL?: string | null;
  expiryDate?: string;
  createdAt: string;
  updatedAt: string;
  JobSkills?: JobSkillRef[];
  JobBenefits?: JobBenefit[];
  JobSalaries?: Array<{ CurrencyCode: string; minAmount: number; maxAmount: number }> | null;
  Company?: JobCompany;
  hierarchicalLocation?: { id: string; name: string; formattedName: string };
  fraudReportFlag?: boolean;
  source?: string;
  traceInfo?: string;
  isApplied?: boolean;
}

export interface RecommendedJobsResponse {
  data: RecommendedJob[];
  // Server may also return paging metadata under various keys; we don't rely on them.
}

export interface OneTapProfileQuestion {
  name: string;
  type: string;
  isAlreadyFilled: boolean;
  responseRequirement?: string;
}

export interface OneTapApplyQuestionsResponse {
  getOneTapJobApplyQuestions: {
    profileQuestions: OneTapProfileQuestion[];
  };
}

export interface ApplyAnswer {
  QuestionName: string;
  answer: string | string[] | number | boolean;
}

export interface ApplyResponse {
  data: {
    id: string;
    JobId: string;
    ApplicantId: string;
    status: string;
    source: string;
    expectedSalary?: number;
    createdAt: string;
    updatedAt: string;
  };
  expInfo?: string;
}

export interface ChatChannelStartResponse {
  code: string;
  data: {
    id: string;
    type: string;
    chatStatus: string;
    applicationStatus: string;
    creatorID: string;
    source: string;
    unreadNumber: number;
    createdAt: number;
    updatedAt: number;
    job?: { id: string; title: string };
    company?: { id: string; name: string };
  };
}

export interface ChatMessageResponse {
  code: string;
  data: {
    id: string;
    messageID: string;
    channelID: string;
    messageStatus: string;
    contentType: string;
    content: { text?: string; type?: string; [k: string]: unknown };
    createdAt: number;
    updatedAt: number;
  };
}

export interface MessagingIntroMessage {
  userId: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}
