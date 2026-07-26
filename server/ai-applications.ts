/**
 * AI Applications (Discovery Engine) — app + data-source type catalog.
 * Console name: AI Applications. API: discoveryengine.googleapis.com
 */

export type AiAppType =
  | 'search_docs'
  | 'chat_rag'
  | 'website'
  | 'structured'
  | 'media';

export type DataSourceType =
  | 'none'
  | 'local_upload'
  | 'google_drive'
  | 'website_url'
  | 'cloud_storage'
  | 'api_import'
  | 'vertex_studio';

export type AiAppTypeInfo = {
  id: AiAppType;
  label: string;
  description: string;
  /** Discovery Engine solution type */
  solutionType: 'SOLUTION_TYPE_SEARCH' | 'SOLUTION_TYPE_CHAT';
  industryVertical: 'GENERIC' | 'MEDIA';
  contentConfig: 'CONTENT_REQUIRED' | 'NO_CONTENT' | 'PUBLIC_WEBSITE';
  recommendedSources: DataSourceType[];
};

export type DataSourceTypeInfo = {
  id: DataSourceType;
  label: string;
  description: string;
  /** Needs Drive OAuth + folder/file pick */
  needsDrive?: boolean;
  /** Needs website URL field */
  needsWebsiteUrl?: boolean;
  /** Needs GCS URI field */
  needsGcsUri?: boolean;
  /** Empty store; customer fills via console / later API */
  emptyThenConfigure?: boolean;
};

export const AI_APP_TYPES: AiAppTypeInfo[] = [
  {
    id: 'search_docs',
    label: '문서 검색 (Search)',
    description: 'PDF·Docs·텍스트 등 비정형 문서 RAG. 일반 지식베이스에 적합.',
    solutionType: 'SOLUTION_TYPE_SEARCH',
    industryVertical: 'GENERIC',
    contentConfig: 'CONTENT_REQUIRED',
    recommendedSources: ['local_upload', 'google_drive', 'website_url', 'none'],
  },
  {
    id: 'chat_rag',
    label: '대화형 RAG (Chat)',
    description:
      '문서 근거로 대화하는 RAG. Agent Search Answer API(자연어 Q&A)를 쓰도록 Search+LLM 엔진으로 생성합니다.',
    // Answer API docs target Search engines (…/servingConfigs/default_search:answer).
    // SOLUTION_TYPE_CHAT is Dialogflow-oriented and is a poor fit for :answer.
    solutionType: 'SOLUTION_TYPE_SEARCH',
    industryVertical: 'GENERIC',
    contentConfig: 'CONTENT_REQUIRED',
    recommendedSources: ['local_upload', 'google_drive', 'none'],
  },
  {
    id: 'website',
    label: '웹사이트 검색',
    description: '공개 웹 페이지를 인덱싱. 도움말 사이트·마케팅 페이지.',
    solutionType: 'SOLUTION_TYPE_SEARCH',
    industryVertical: 'GENERIC',
    contentConfig: 'PUBLIC_WEBSITE',
    recommendedSources: ['website_url', 'local_upload', 'none'],
  },
  {
    id: 'structured',
    label: '구조화 데이터',
    description: 'JSON/CSV 등 구조화 파일을 스튜디오에서 업로드해 적재.',
    solutionType: 'SOLUTION_TYPE_SEARCH',
    industryVertical: 'GENERIC',
    contentConfig: 'NO_CONTENT',
    recommendedSources: ['local_upload', 'none'],
  },
  {
    id: 'media',
    label: '미디어 / 멀티모달',
    description: '이미지·미디어 중심 검색(미디어 vertical). 텍스트 메타는 로컬 업로드.',
    solutionType: 'SOLUTION_TYPE_SEARCH',
    industryVertical: 'MEDIA',
    contentConfig: 'CONTENT_REQUIRED',
    recommendedSources: ['local_upload', 'google_drive', 'none'],
  },
];

export const DATA_SOURCE_TYPES: DataSourceTypeInfo[] = [
  {
    id: 'local_upload',
    label: '로컬 파일 첨부',
    description: 'PC에서 문서를 올리면 SolVamos가 데이터스토어에 넣습니다. GCP 콘솔 불필요.',
  },
  {
    id: 'google_drive',
    label: 'Google Drive',
    description: '폴더/파일을 수집해 문서 스토어에 주입.',
    needsDrive: true,
  },
  {
    id: 'website_url',
    label: '웹사이트 URL',
    description: '공개 사이트 URL을 AI Applications 웹 인덱싱에 등록.',
    needsWebsiteUrl: true,
  },
  {
    id: 'cloud_storage',
    label: 'Cloud Storage (GCS)',
    description: '운영 전용 — 고객 UI에 노출하지 않음.',
    needsGcsUri: true,
    emptyThenConfigure: true,
  },
  {
    id: 'api_import',
    label: 'API 문서 임포트',
    description: '운영 전용 — 플랫폼이 importDocuments로 적재.',
    emptyThenConfigure: true,
  },
  {
    id: 'vertex_studio',
    label: 'Vertex AI Studio / 콘솔',
    description: '운영 전용 — 고객은 GCP 콘솔을 사용하지 않음.',
    emptyThenConfigure: true,
  },
  {
    id: 'none',
    label: '지식 없이 시작',
    description: '앱+빈 데이터스토어만 생성. 나중에 로컬 첨부로 추가 가능.',
    emptyThenConfigure: true,
  },
];

export function getAiAppType(id: string | undefined): AiAppTypeInfo {
  return AI_APP_TYPES.find((t) => t.id === id) || AI_APP_TYPES[0];
}

export function getDataSourceType(id: string | undefined): DataSourceTypeInfo {
  return DATA_SOURCE_TYPES.find((t) => t.id === id) || DATA_SOURCE_TYPES[0];
}

export function aiApplicationsCatalog() {
  return {
    location: process.env.VERTEX_SEARCH_LOCATION || 'global',
    collection: process.env.VERTEX_SEARCH_COLLECTION || 'default_collection',
    appTypes: AI_APP_TYPES,
    dataSourceTypes: DATA_SOURCE_TYPES,
    note:
      'AI Applications = Discovery Engine. Always create app(engine)+data store on agent create; source ingest depends on dataSourceType.',
  };
}
