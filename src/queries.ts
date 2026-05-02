// GraphQL operations captured from the Glints Android app (v1.106.2).
// Two GraphQL endpoints:
//   /api/graphql        — identity, profile, preferences
//   /v2/api/graphql     — feature flags, similar jobs, one-tap apply questions, ...

export const Q_GET_ME = `query getMe {
  __typename
  getMe { __typename ...MeFragment }
}

fragment MeFragment on Me {
  __typename id email firstName lastName gender intro isVerified phone profilePic
  CountryCode age birthDate careerStartDate highestEducationLevel resume ugcFullName
  LocationId role companyRole isJobRolePreferencesFilled isJobLocationPreferencesFilled
  createdAt updatedAt applicationsCount whatsappNumber whatsappLoginNumber profileCompletionPercentage
  country { __typename callingCode code name demonym }
  hierarchicalLocation {
    __typename id name formattedName countryCode level
    parents { __typename id name formattedName countryCode level }
  }
  preferredLocations { __typename latitude longitude }
  metadata
}`;

export const Q_GET_ENABLED_FEATURE_FLAGS = `query getEnabledFeatureFlags {
  __typename
  getEnabledFeatureFlags { __typename flags }
}`;

export const Q_CHECK_VERSION = `query checkMobileAppVersionCompatibility($version: String!, $platform: EAppPlatform!) {
  __typename
  checkMobileAppVersionCompatibility(version: $version, platform: $platform) {
    __typename isCompatible isLatest minimumSupportedVersion latestVersion
  }
}`;

export const Q_ONE_TAP_APPLY_QUESTIONS = `query getOneTapJobApplyQuestions($jobId: String!) {
  __typename
  getOneTapJobApplyQuestions(jobId: $jobId) {
    __typename
    profileQuestions { __typename name type isAlreadyFilled responseRequirement }
  }
}`;

export const Q_GET_BOOKMARKED_JOBS = `query getBookmarkedJobs($data: GetBookmarkJobsInput!) {
  __typename
  getBookmarkedJobs(data: $data) { __typename totalJobs }
}`;

export const M_UPDATE_ME = `mutation updateMe($me: UpdateMeInput!) {
  __typename
  updateMe(me: $me) { __typename id }
}`;

export const Q_IS_QUALIFIED_TO_APP_REVIEW = `query isQualifiedToAppReview($actionType: PromptAppReviewActionType!) {
  __typename
  isQualifiedToAppReview(actionType: $actionType)
}`;

export const Q_GET_MESSAGING_INTRO_MESSAGE = `query getMessagingIntroMessage {
  __typename
  getMessagingIntroMessage {
    __typename userId message createdAt updatedAt
  }
}`;

export const M_UPDATE_MESSAGING_INTRO_MESSAGE = `mutation updateMessagingIntroMessage($message: String!) {
  __typename
  updateMessagingIntroMessage(message: $message) {
    __typename userId message updatedAt
  }
}`;

export const Q_JOB_ROLE_PREFERENCES_FULL = `query jobRolePreferences {
  __typename
  jobRolePreferences {
    __typename
    id
    HierarchicalJobCategoryId
    hierarchicalJobCategory { __typename id name level }
  }
}`;

export const Q_HIERARCHICAL_JOB_CATEGORIES_FULL = `query hierarchicalJobCategories {
  __typename
  hierarchicalJobCategories {
    __typename id name level parentId
  }
}`;
