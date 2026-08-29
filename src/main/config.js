// Central, runtime-shared configuration. Exposed to the renderer over IPC
// (caos:config) so the UI, the webview inspector, and exports all agree on
// the same action tags, AI tasks, and defaults.

const ACTION_TAGS = [
  { id: 'remove', label: 'Remove', color: '#ff6b6b' },
  { id: 'change', label: 'Change', color: '#ffb454' },
  { id: 'fix', label: 'Fix', color: '#5b8cff' },
  { id: 'add', label: 'Add', color: '#3ddc97' },
  { id: 'question', label: 'Question', color: '#c792ea' },
  { id: 'comment', label: 'Comment', color: '#9aa2b1' },
];

const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const STATUSES = ['open', 'resolved'];

// Assertion step kinds for recordings (journeys-as-tests). `count`'s "contains"
// op means "at least"; `url` is evaluated host-side against the live location.
const ASSERTION_KINDS = [
  { id: 'exists', label: 'Element exists', selector: true, expected: false },
  { id: 'visible', label: 'Element is visible', selector: true, expected: false },
  { id: 'text', label: 'Element text', selector: true, expected: true, ops: ['contains', 'equals', 'matches'] },
  { id: 'count', label: 'Element count', selector: true, expected: true, ops: ['equals', 'contains'] },
  { id: 'url', label: 'Page URL', selector: false, expected: true, ops: ['contains', 'equals', 'matches'] },
];

// AI tasks the assistant can run over a review session.
const AI_TASKS = {
  transcribe: 'Clean raw notes into a polished, structured review document.',
  prompt: 'Produce a precise change-request prompt for a coding agent.',
  cluster: 'Group related notes into themes and order them.',
  summary: 'Summarize the overall state of the UI and top issues.',
  'suggest-fix': 'Propose a concrete code fix for a single annotation.',
};

const DEFAULT_SETTINGS = {
  onboardingComplete: false,
  profile: {
    displayName: '',
  },
  aiProvider: 'claude',
  models: {
    claude: 'claude-sonnet-4-6',
    openai: 'gpt-4o',
  },
  replayDelayMs: 600,
  // Left sidebar: which page tab is showing, and whether the library drawer
  // (projects / sessions / recordings / bookmarks / history) is expanded.
  sideTab: 'sections',
  libraryOpen: false,
  theme: 'dark',
  restoreAnnotationsOnLoad: true,
  // Optional shell command run on agent hand-off, in the project dir.
  // Supports {promptPath} and {projectPath}. Empty = only write the request file.
  agentCommand: '',
};

module.exports = { ACTION_TAGS, PRIORITIES, STATUSES, ASSERTION_KINDS, AI_TASKS, DEFAULT_SETTINGS };
