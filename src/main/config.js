// Central, runtime-shared configuration. Exposed to the renderer over IPC
// (caos:config) so the UI, the webview inspector, the native menu, and exports
// all agree on the same action tags, AI tasks, devices, themes, and defaults.

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

// Device viewports the guest stage can be constrained to. `fit` fills the
// stage (the normal desktop-browser behaviour); every other preset renders the
// page at an exact CSS pixel size so responsive breakpoints can be reviewed.
const DEVICE_PRESETS = [
  { id: 'fit', label: 'Fit to window', w: 0, h: 0 },
  { id: 'mobile-s', label: 'Mobile', w: 375, h: 667 },
  { id: 'mobile-l', label: 'Mobile L', w: 430, h: 932 },
  { id: 'tablet', label: 'Tablet', w: 820, h: 1180 },
  { id: 'laptop', label: 'Laptop', w: 1280, h: 800 },
  { id: 'desktop', label: 'Desktop', w: 1440, h: 900 },
];

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
];

// AI tasks the assistant can run over a review session.
const AI_TASKS = {
  transcribe: 'Clean raw notes into a polished, structured review document.',
  prompt: 'Produce a precise change-request prompt for a coding agent.',
  cluster: 'Group related notes into themes and order them.',
  summary: 'Summarize the overall state of the UI and top issues.',
  'suggest-fix': 'Propose a concrete code fix for a single annotation.',
};

// Known-good model ids offered in the Settings picker. Free text is still
// accepted so a newly released model can be used before this list catches up.
const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fastest' },
];
const OPENAI_MODELS = [
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini — fastest' },
  { id: 'o4-mini', label: 'o4-mini — reasoning' },
  { id: 'gpt-4.1', label: 'GPT-4.1' },
];

// Both Anthropic providers answer to the same model ids, and so do both OpenAI
// ones — what differs between them is who pays, not what you can ask for. This
// list is refreshed from the ai-auth registry at boot, so it cannot drift from
// the ids the providers actually accept.
const MODEL_CHOICES = {
  'claude-code': ANTHROPIC_MODELS,
  anthropic: ANTHROPIC_MODELS,
  codex: OPENAI_MODELS,
  openai: OPENAI_MODELS,
};

// Severity ladder used by the page audit. Ordered most → least severe.
const AUDIT_SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];

// Keyboard shortcuts, rendered by the in-app Help → Keyboard Shortcuts modal.
// Kept next to the menu definition so the two never drift apart.
const SHORTCUTS = [
  {
    group: 'Browsing',
    items: [
      ['New tab', 'Mod+T'],
      ['Close tab', 'Mod+W'],
      ['Reload page', 'Mod+R'],
      ['Focus address bar', 'Mod+L'],
      ['Back / Forward', 'Mod+[ / Mod+]'],
      ['Bookmark page', 'Mod+D'],
    ],
  },
  {
    group: 'Reviewing',
    items: [
      ['Inspect elements', 'Mod+Shift+E'],
      ['Draw a region', 'Mod+Shift+D'],
      ['Edit content & style', 'Mod+Shift+T'],
      ['Rearrange layout', 'Mod+Shift+M'],
      ['Add assertion', 'Mod+Shift+A'],
      ['Run page audit', 'Mod+Shift+U'],
      ['Undo / redo page edit', 'Mod+Shift+Z / Mod+Shift+Y'],
      ['Exit the current mode', 'Esc'],
    ],
  },
  {
    group: 'On the page',
    items: [
      ['Capture / select the element', 'Click'],
      ['Edit the text right there', 'Double-click'],
      ['Move it (Rearrange) or circle it (Draw)', 'Drag'],
      ['Free-move, ignoring the layout', 'Alt+Drag'],
      ['Cancel the drag or close the note', 'Esc'],
      ['Scrub a number in the Style panel', 'Drag a label'],
      ['Save the note you are writing', 'Mod+Enter'],
    ],
  },
  {
    group: 'Journeys',
    items: [
      ['Record / stop recording', 'Mod+Shift+J'],
      ['Replay selected journey', 'Mod+Shift+P'],
      ['Screenshot (viewport)', 'Mod+Shift+S'],
      ['Screenshot (full page)', 'Mod+Alt+S'],
    ],
  },
  {
    group: 'Workspace',
    items: [
      ['Notes / Style / Audit / AI', 'Mod+1 … Mod+4'],
      ['Search notes', 'Mod+F'],
      ['Copy agent prompt', 'Mod+Shift+C'],
      ['Hand off to coding agent', 'Mod+Shift+H'],
      ['Rotate device viewport', 'Mod+Shift+R'],
      ['Keyboard shortcuts', 'Mod+/'],
    ],
  },
];

const DEFAULT_SETTINGS = {
  onboardingComplete: false,
  profile: {
    displayName: '',
  },
  // The subscription already signed in on this machine is the default, so the AI
  // features work on a fresh install with nothing pasted anywhere. With no
  // `claude` login present this simply reports "not connected" in Settings and
  // AI tasks answer locally until a credential is added.
  aiProvider: 'claude-code',
  models: {
    'claude-code': 'claude-sonnet-5',
    anthropic: 'claude-sonnet-5',
    codex: 'gpt-5',
    openai: 'gpt-5',
  },
  replayDelayMs: 600,
  // Left sidebar: which page tab is showing, and whether the library drawer
  // (projects / sessions / recordings / bookmarks / history) is expanded.
  sideTab: 'sections',
  libraryOpen: false,
  theme: 'dark',
  device: 'fit',
  deviceLandscape: false,
  restoreAnnotationsOnLoad: true,
  // Optional shell command run on agent hand-off, in the project dir.
  // Supports {promptPath} and {projectPath}. Empty = only write the request file.
  agentCommand: '',
};

module.exports = {
  ACTION_TAGS,
  PRIORITIES,
  STATUSES,
  ASSERTION_KINDS,
  DEVICE_PRESETS,
  THEMES,
  AI_TASKS,
  MODEL_CHOICES,
  AUDIT_SEVERITIES,
  SHORTCUTS,
  DEFAULT_SETTINGS,
};
