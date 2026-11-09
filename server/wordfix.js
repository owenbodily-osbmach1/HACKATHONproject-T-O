// Caption cleanup applied by the hub to each final caption line (and to interim text, so the
// phone display matches what is stored). Pure, synchronous, conservative: fixes cloud-native
// terms speech recognition mishears, tidies spacing, capitalises, and collapses exact
// adjacent duplicate words. It never rewrites meaning and fix(fix(x)) === fix(x).
// fix() never throws: on any problem it returns the original text.

const MAX_LEN = 4000; // longer than any real caption line; anything bigger is passed through untouched

// [pattern, replacement]. Patterns are case-insensitive and word-bounded.
const TERMS = [
  [/\b(?:cube|kube)[\s-]*(?:control|ctl|cuddle|cuttle|c\s?t\s?l)\b/gi, 'kubectl'],
  [/\bkubectl\b/gi, 'kubectl'],
  [/\b(?:cooper|kooper|coober|kuber|cuber)[\s-]*(?:netties|nettys|netes|neddies|nettis|nities)\b/gi, 'Kubernetes'],
  [/\bkubernetes\b/gi, 'Kubernetes'],
  [/\bkube[\s-]?let\b/gi, 'kubelet'],
  [/\bcube[\s-]?let\b/gi, 'kubelet'],
  [/\b(?:kube|cube)[\s-]?(?:adm|a\s?d\s?m)\b/gi, 'kubeadm'],
  [/\b(?:kube|cube)[\s-]?con\b/gi, 'KubeCon'],
  [/\bkubecon\b/gi, 'KubeCon'],
  [/\bk8s\b/gi, 'K8s'],
  [/\bdash[\s-]?(?:zero|0)\b/gi, 'Dash0'],
  [/\bdash0\b/gi, 'Dash0'],
  [/\bopen[\s-]?telemetry\b/gi, 'OpenTelemetry'],
  [/\bo[\s-]?tel\b/gi, 'OTel'],
  [/\belastic[\s-]search\b/gi, 'Elasticsearch'],
  [/\belasticsearch\b/gi, 'Elasticsearch'],
  [/\bgitar\b/gi, 'Gitar'],
  [/\bguitar(?=[\s.-]+(?:ai|agents?|bots?|code[\s-]?reviews?|reviews?|reviewer|ci)\b)/gi, 'Gitar'],
  [/\bargo[\s-]?(?:cd|c\.d\.?|c\s?d|see\s?d|seedy|sidi)\b/gi, 'Argo CD'],
  [/\bargo[\s-]?workflows?\b/gi, 'Argo Workflows'],
  [/\bprometheus\b/gi, 'Prometheus'],
  [/\bgrafana\b|\bgraf[\s-]?ana\b|\bgraphana\b|\bgrafanna\b/gi, 'Grafana'],
  [/\b(?:e[\s.]?t[\s.]?c[\s.]?d|et[\s-]?cee[\s-]?dee|etc[\s-]?d|etcd)\b/gi, 'etcd'],
  [/\b(?:g[\s.]?r[\s.]?p[\s.]?c|gee[\s-]?rpc|jee[\s-]?rpc|grpc)\b/gi, 'gRPC'],
  [/\b(?:yaml|yammel|yamel|yamil|yammal)\b/gi, 'YAML'],
  [/\bci[\s]*(?:\/|-|slash)[\s]*cd\b/gi, 'CI/CD'],
  [/\b(?:ci\s+cd|cicd|c\s?i\s?c\s?d)\b/gi, 'CI/CD'],
  [/\bkelsey[\s-]*(?:high[\s-]?tower|hi[\s-]?tower|height[\s-]?tower|hightower)\b/gi, 'Kelsey Hightower'],
  [/\bkelsey\b/g, 'Kelsey'],
  [/\bistio\b/gi, 'Istio'],
  [/\bterraform\b/gi, 'Terraform'],
  [/\bdocker\b/gi, 'Docker'],
  [/\bopenshift\b/gi, 'OpenShift'],
  [/\bgithub\b/gi, 'GitHub'],
  [/\bgitlab\b/gi, 'GitLab'],
  [/\bgit[\s-]ops\b|\bgitops\b/gi, 'GitOps'],
  [/\bdev[\s-]ops\b|\bdevops\b/gi, 'DevOps'],
  [/\bpost[\s-]?gres(?:ql)?\b/gi, 'Postgres'],
  [/\bcncf\b/gi, 'CNCF'],
  [/\bebpf\b/gi, 'eBPF'],
  [/\bapis\b/gi, 'APIs'],
  [/\b(?:ai|api|cli|cpu|gpu|dns|tls|json|sql|sre|sdk|sso|rbac|ssh)\b/gi, (m) => m.toUpperCase()],
  [/\bhttps\b/gi, 'HTTPS'],
  [/\bhttp\b/gi, 'HTTP'],
];

// Canonical terms that start in lower case; a line starting with one is not capitalised.
const KEEP_LOWER = new Set(['kubectl', 'kubelet', 'kubeadm', 'etcd', 'gRPC', 'eBPF']);

// Words that may be legitimately doubled.
const MAY_REPEAT = new Set([
  'had', 'that', 'bye', 'no', 'so', 'very', 'really', 'yes', 'yeah', 'ha', 'ho', 'well',
  'go', 'more', 'many', 'much', 'pretty',
]);

const ABBREV = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'approx', 'mr', 'mrs', 'ms', 'dr', 'no', 'fig', 'inc', 'ltd', 'st', 'cf',
]);

const STUTTER = /(^|[^\p{L}\p{N}'’])([\p{L}][\p{L}'’]*)((?:\s+\2(?![\p{L}\p{N}'’]))+)/giu;
const STANDALONE_I = /(?<![\p{L}\p{N}.\-\/'’])i(?=$|[\s,;:!?]|\.(?:\s|$)|['’](?:m|ll|ve|d)(?![\p{L}]))/gu;
const SENTENCE_START = /([\p{L}\p{N}'’)"”][.!?])(\s+)(\p{Ll})/gu;

function applyTerms(text) {
  let out = text;
  for (const [re, to] of TERMS) out = out.replace(re, to);
  return out;
}

function collapseStutters(text) {
  return text.replace(STUTTER, (all, lead, word) => {
    if (MAY_REPEAT.has(word.toLowerCase())) return all;
    return lead + word;
  });
}

function firstToken(text, from) {
  const m = /^[^\p{L}\p{N}]*([\p{L}\p{N}][\p{L}\p{N}'’]*(?:[./][\p{L}\p{N}]+)*)/u.exec(text.slice(from));
  return m ? m[1] : '';
}

function keepsCase(token) {
  return KEEP_LOWER.has(token.replace(/['’]s$/, '')) || /[./]/.test(token);
}

function capitaliseAt(text, index) {
  const ch = text[index];
  const up = ch.toUpperCase();
  return up === ch ? text : text.slice(0, index) + up + text.slice(index + 1);
}

function capitalise(text) {
  let out = text;
  const lead = /^[^\p{L}\p{N}-]*/u.exec(out)[0].length;
  if (lead < out.length && /\p{Ll}/u.test(out[lead]) && !keepsCase(firstToken(out, 0))) {
    out = capitaliseAt(out, lead);
  }
  out = out.replace(SENTENCE_START, (all, before, space, letter, offset) => {
    const prior = out.slice(0, offset + before.length - 1).split(/\s+/).pop().toLowerCase();
    if (ABBREV.has(prior.replace(/^[^\p{L}]+/u, ''))) return all;
    const word = firstToken(out, offset + before.length + space.length);
    if (keepsCase(word)) return all;
    return before + space + letter.toUpperCase();
  });
  return out;
}

function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])(?=\s|$)/g, '$1')
    .trim();
}

// File names, URLs, e-mail addresses and paths are never touched: they are swapped for a
// single private-use character while the rules run, then put back.
const OPAQUE = /(?<!\S)(?:[~.]?\/\S*|\S*(?:@|:\/\/|\\|[\p{L}\p{N}]\.[\p{L}\p{N}])\S*)/gu;
const PLACEHOLDER = /[\uE000-\uF8FF]/;

function clean(text) {
  if (PLACEHOLDER.test(text)) return text;
  const kept = [];
  const masked = text.replace(OPAQUE, (token) => {
    if (kept.length >= 6000) return token;
    kept.push(token);
    return String.fromCharCode(0xE000 + kept.length - 1);
  });
  const out = clean1(masked);
  return out.replace(/[\uE000-\uF8FF]/g, (c) => kept[c.charCodeAt(0) - 0xE000] || c);
}

function clean1(text) {
  let out = tidy(text);
  out = applyTerms(out);
  out = collapseStutters(out);
  out = out.replace(STANDALONE_I, 'I');
  out = capitalise(out);
  return out;
}

// Returns the cleaned text, or the original when it is not a string, too long, or anything fails.
function fix(text) {
  if (typeof text !== 'string' || text.length > MAX_LEN) return text;
  try {
    const out = clean(text);
    return out || text;
  } catch {
    return text;
  }
}

module.exports = { fix, TERMS };
