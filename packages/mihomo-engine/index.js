import YAML from 'yaml';

const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';

const PRIVATE_RULES = [
  'DOMAIN-SUFFIX,local,DIRECT',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,224.0.0.0/4,DIRECT,no-resolve',
  'IP-CIDR6,::1/128,DIRECT,no-resolve',
  'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
  'IP-CIDR6,fe80::/10,DIRECT,no-resolve'
];

const ADS_RULES = [
  'DOMAIN-SUFFIX,doubleclick.net,REJECT',
  'DOMAIN-SUFFIX,googlesyndication.com,REJECT',
  'DOMAIN-SUFFIX,googleadservices.com,REJECT',
  'DOMAIN-SUFFIX,adsystem.com,REJECT',
  'DOMAIN-KEYWORD,adservice,REJECT',
  'DOMAIN-KEYWORD,analytics,REJECT'
];

export function createDefaultProfile() {
  return {
    name: 'Mihomo VLESS Profile',
    mode: 'rule',
    mixedPort: 7890,
    socksPort: 7891,
    externalController: '127.0.0.1:9090',
    allowLan: false,
    ipv6: false,
    logLevel: 'info',
    tun: {
      enabled: true,
      stack: 'mixed',
      autoRoute: true,
      strictRoute: false,
      dnsHijack: ['any:53']
    },
    dns: {
      enabled: true,
      enhancedMode: 'fake-ip',
      listen: '0.0.0.0:1053',
      nameservers: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
      fallback: ['tls://1.0.0.1:853', 'tls://8.8.4.4:853'],
      fakeIpFilter: ['*.lan', '*.local', 'localhost.ptlogin2.qq.com']
    },
    groups: {
      auto: true,
      fallback: true,
      loadBalance: false,
      testUrl: DEFAULT_TEST_URL,
      interval: 300
    },
    rules: {
      bypassPrivate: true,
      blockAds: false,
      final: 'PROXY',
      custom: []
    },
    nodes: []
  };
}

export function parseVlessUri(uri, index = 0) {
  const trimmed = String(uri ?? '').trim();
  if (!trimmed) {
    throw new Error('Empty VLESS link');
  }

  if (!trimmed.toLowerCase().startsWith('vless://')) {
    throw new Error('Only vless:// links are supported by this parser');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(`Invalid VLESS URL: ${error.message}`);
  }

  const params = parsed.searchParams;
  const type = params.get('type') || params.get('network') || 'tcp';
  const security = params.get('security') || '';
  const rawName = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim();
  const name = rawName || `VLESS ${index + 1}`;
  const port = Number(parsed.port || params.get('port') || 443);

  const node = compactObject({
    id: makeNodeId(name, index),
    name,
    type: 'vless',
    server: parsed.hostname,
    port,
    uuid: parsed.username ? decodeURIComponent(parsed.username) : '',
    udp: valueFromParam(params.get('udp'), true),
    tls: security === 'tls' || security === 'reality',
    network: type,
    servername: params.get('sni') || params.get('servername') || params.get('host') || undefined,
    flow: params.get('flow') || undefined,
    'client-fingerprint': params.get('fp') || params.get('fingerprint') || undefined,
    'skip-cert-verify': valueFromParam(params.get('allowInsecure') || params.get('skip-cert-verify'), undefined)
  });

  if (type === 'ws') {
    node['ws-opts'] = {
      path: decodeQueryValue(params.get('path') || '/'),
      headers: compactObject({
        Host: params.get('host') || params.get('sni') || undefined
      })
    };
  }

  if (type === 'grpc') {
    node['grpc-opts'] = compactObject({
      'grpc-service-name': params.get('serviceName') || params.get('service-name') || undefined
    });
  }

  if (type === 'h2') {
    node['h2-opts'] = compactObject({
      host: splitCsv(params.get('host')),
      path: decodeQueryValue(params.get('path') || '/')
    });
  }

  if (security === 'reality') {
    node['reality-opts'] = compactObject({
      'public-key': params.get('pbk') || params.get('public-key') || undefined,
      'short-id': params.get('sid') || params.get('short-id') || undefined
    });
  }

  return normalizeNode(node, index);
}

export function parseSubscriptionText(text) {
  const source = String(text ?? '').trim();
  if (!source) {
    return { nodes: [], errors: [] };
  }

  const decoded = maybeDecodeBase64(source);
  const errors = [];
  const nodes = parseVlessLinks(decoded, errors);
  const yaml = parseClashYamlProxies(decoded);

  errors.push(...yaml.errors);
  nodes.push(...yaml.nodes);

  if (!nodes.length && !errors.length) {
    errors.push({ line: 'subscription', message: 'No supported VLESS servers were found in the subscription.' });
  }

  return { nodes: uniqueNodes(nodes), errors };
}

function parseVlessLinks(text, errors = []) {
  const nodes = [];
  const links = text
    .split(/\r?\n|\s+/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith('vless://'));

  links.forEach((link, index) => {
    try {
      nodes.push(parseVlessUri(link, index));
    } catch (error) {
      errors.push({ line: link.slice(0, 80), message: error.message });
    }
  });

  return nodes;
}

function parseClashYamlProxies(text) {
  if (!/^\s*proxies\s*:/m.test(text)) {
    return { nodes: [], errors: [] };
  }

  const errors = [];
  const rawNodes = parseMihomoYaml(text).proxies || [];
  const nodes = [];
  const unsupportedTypes = new Set();

  rawNodes.forEach((node, index) => {
    if (String(node.type || '').toLowerCase() !== 'vless') {
      if (node.type) {
        unsupportedTypes.add(String(node.type));
      }
      return;
    }

    if (isUnsupportedPlaceholder(node)) {
      errors.push({
        line: node.name || `proxy ${index + 1}`,
        message: 'Subscription returned a provider placeholder instead of a usable server.'
      });
      return;
    }

    const warnings = [];
    nodes.push(normalizeNode(node, index, warnings));
    errors.push(...warnings.map((message) => ({ line: node.name || `proxy ${index + 1}`, message })));
  });

  if (!nodes.length && unsupportedTypes.size) {
    errors.push({
      line: 'proxies',
      message: `No supported VLESS proxies found. Unsupported proxy types: ${Array.from(unsupportedTypes).join(', ')}.`
    });
  }

  return { nodes, errors };
}

function parseMihomoYaml(text) {
  try {
    const parsed = YAML.parse(addYamlTagsToRealityShortId(text), { merge: true });
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function addYamlTagsToRealityShortId(yamlContent) {
  if (!yamlContent.includes('proxies:') || !yamlContent.includes('short-id:')) {
    return yamlContent;
  }

  const lines = yamlContent.split('\n');
  const result = [];
  let inProxies = false;
  let inProxy = false;
  let inReality = false;
  let proxiesIndent = -1;
  let proxyIndent = -1;
  let realityIndent = -1;
  const shortIdRegex = /^(\s*short-id:\s*)([^\s#]+)(.*)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line);
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (trimmed.startsWith('proxies:') && indent === 0) {
      inProxies = true;
      inProxy = false;
      inReality = false;
      proxiesIndent = indent;
    } else if (inProxies && indent <= proxiesIndent && !trimmed.startsWith('-')) {
      inProxies = false;
      inProxy = false;
      inReality = false;
    }

    if (inProxies) {
      if (trimmed.startsWith('-')) {
        inProxy = true;
        inReality = false;
        proxyIndent = indent;
      } else if (inProxy && indent <= proxyIndent) {
        inProxy = false;
        inReality = false;
      }

      if (inProxy) {
        if (trimmed.startsWith('reality-opts:')) {
          inReality = true;
          realityIndent = indent;
        } else if (inReality && indent <= realityIndent) {
          inReality = false;
        }

        if (inReality && trimmed.includes('short-id:')) {
          const match = line.match(shortIdRegex);
          if (match) {
            const [, prefix, value, suffix] = match;
            if (
              value.toLowerCase() !== 'null' &&
              value !== '~' &&
              !value.startsWith('!!') &&
              !value.startsWith('{') &&
              !value.startsWith('[')
            ) {
              result.push(`${prefix}!!str ${value}${suffix}`);
              continue;
            }
          }
        }
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

function readProxyObjects(text) {
  const lines = text.split(/\r?\n/);
  const proxies = [];
  let inProxies = false;
  let listIndent = null;
  let current = null;
  let stack = [];

  for (const rawLine of lines) {
    if (!inProxies) {
      const match = rawLine.match(/^proxies:\s*(.*)$/);
      if (!match) continue;
      if (match[1].trim() === '[]') return [];
      inProxies = true;
      continue;
    }

    if (/^[^\s][^:]*:\s*/.test(rawLine)) break;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    const item = rawLine.match(/^(\s*)-\s+(.*)$/);
    if (item) {
      const indent = item[1].length;
      if (listIndent === null) listIndent = indent;

      if (indent === listIndent) {
        if (current) proxies.push(current);
        current = {};
        stack = [{ indent, target: current }];
        assignYamlProperty(current, item[2]);
        continue;
      }

      const target = stack.at(-1)?.target;
      if (Array.isArray(target)) {
        target.push(parseYamlScalar(item[2]));
      }
      continue;
    }

    if (!current) continue;

    const property = rawLine.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!property) continue;

    const indent = property[1].length;
    const key = property[2].trim();
    const value = property[3].trim();

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).target;
    if (value === '') {
      parent[key] = {};
      stack.push({ indent, target: parent[key] });
    } else {
      parent[key] = parseYamlScalar(value);
    }
  }

  if (current) proxies.push(current);
  return proxies;
}

function assignYamlProperty(target, expression) {
  const colon = expression.indexOf(':');
  if (colon === -1) return;
  const key = expression.slice(0, colon).trim();
  const value = expression.slice(colon + 1).trim();
  target[key] = value === '' ? {} : parseYamlScalar(value);
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '[]') return [];
  return trimmed;
}

function isUnsupportedPlaceholder(node) {
  const name = String(node.name || '').toLowerCase();
  return name.includes('\u043d\u0435 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044f') || name.includes('not supported') || Number(node.port) === 1;
  return name.includes('не поддерживается') || name.includes('not supported') || Number(node.port) === 1;
}

export function buildMihomoProfile(input = {}) {
  const profile = mergeProfile(createDefaultProfile(), input);
  const warnings = [];
  const selectedNodes = (profile.nodes || [])
    .filter((node) => node.enabled !== false)
    .filter(hasNodeIdentity);
  const nodes = uniqueNodes(selectedNodes.map((node, index) => normalizeNode(node, index, warnings)));
  const nodeNames = nodes.map((node) => node.name);
  const proxyNames = nodeNames.length ? nodeNames : ['DIRECT'];
  const finalPolicy = sanitizePolicy(profile.rules.final, nodeNames);

  if (!nodes.length) {
    warnings.push('No selected proxy nodes were provided. The profile will route traffic to DIRECT.');
  }

  if (sanitizeMode(profile.mode) === 'direct') {
    warnings.push('Direct mode bypasses proxy nodes. Use Rule or Global to route traffic through the selected server.');
  }

  const config = compactObject({
    mixedPort: Number(profile.mixedPort) || 7890,
    socksPort: Number(profile.socksPort) || 7891,
    allowLan: Boolean(profile.allowLan),
    mode: sanitizeMode(profile.mode),
    logLevel: sanitizeLogLevel(profile.logLevel),
    externalController: String(profile.externalController || '127.0.0.1:9090'),
    ipv6: Boolean(profile.ipv6),
    profile: {
      storeSelected: true,
      storeFakeIp: true
    },
    tun: buildTun(profile.tun),
    dns: buildDns(profile.dns, Boolean(profile.ipv6)),
    proxies: nodes.map(toMihomoProxy),
    proxyGroups: buildProxyGroups(profile.groups, nodeNames, proxyNames),
    rules: buildRules(profile.rules, finalPolicy)
  });

  const yaml = toMihomoYaml(config);

  return {
    yaml,
    config,
    warnings,
    summary: {
      name: profile.name,
      mode: config.mode,
      nodes: nodes.length,
      groups: config.proxyGroups.length,
      rules: config.rules.length,
      dns: Boolean(config.dns?.enable),
      tun: Boolean(config.tun?.enable)
    }
  };
}

export function toMihomoYaml(config) {
  const mihomoConfig = renameKeysDeep(config, {
    mixedPort: 'mixed-port',
    socksPort: 'socks-port',
    allowLan: 'allow-lan',
    logLevel: 'log-level',
    externalController: 'external-controller',
    storeSelected: 'store-selected',
    storeFakeIp: 'store-fake-ip',
    proxyGroups: 'proxy-groups'
  });

  return `${toYaml(mihomoConfig)}\n`;
}

export function validateProfile(input = {}) {
  const result = buildMihomoProfile(input);
  return {
    ok: result.warnings.length === 0,
    warnings: result.warnings,
    summary: result.summary
  };
}

function mergeProfile(base, input) {
  return {
    ...base,
    ...input,
    tun: { ...base.tun, ...(input.tun || {}) },
    dns: { ...base.dns, ...(input.dns || {}) },
    groups: { ...base.groups, ...(input.groups || {}) },
    rules: { ...base.rules, ...(input.rules || {}) },
    nodes: input.nodes || base.nodes
  };
}

function buildTun(tun = {}) {
  if (!tun.enabled) {
    return undefined;
  }

  return compactObject({
    enable: true,
    stack: tun.stack || 'mixed',
    autoRoute: tun.autoRoute !== false,
    strictRoute: Boolean(tun.strictRoute),
    dnsHijack: asArray(tun.dnsHijack).length ? asArray(tun.dnsHijack) : ['any:53']
  });
}

function buildDns(dns = {}, ipv6 = false) {
  if (dns.enabled === false) {
    return undefined;
  }

  return compactObject({
    enable: true,
    listen: dns.listen || '0.0.0.0:1053',
    ipv6,
    enhancedMode: dns.enhancedMode || 'fake-ip',
    fakeIpRange: dns.fakeIpRange || '198.18.0.1/16',
    fakeIpFilter: asArray(dns.fakeIpFilter),
    defaultNameserver: asArray(dns.defaultNameservers || ['1.1.1.1', '8.8.8.8']),
    nameserver: asArray(dns.nameservers),
    fallback: asArray(dns.fallback),
    fallbackFilter: {
      geoip: true,
      geoipCode: 'RU',
      ipcidr: ['240.0.0.0/4']
    }
  });
}

function buildProxyGroups(groups = {}, nodeNames, proxyNames) {
  const testUrl = groups.testUrl || DEFAULT_TEST_URL;
  const interval = Number(groups.interval) || 300;
  const result = [];

  if (nodeNames.length) {
    result.push({
      name: 'GLOBAL',
      type: 'select',
      proxies: uniqueStrings([...nodeNames, 'PROXY', 'DIRECT'])
    });
  }

  const selectorOptions = [];
  if (groups.auto && nodeNames.length) selectorOptions.push('AUTO');
  if (groups.fallback && nodeNames.length) selectorOptions.push('FALLBACK');
  if (groups.loadBalance && nodeNames.length) selectorOptions.push('LOAD-BALANCE');
  selectorOptions.push(...proxyNames, 'DIRECT');

  result.push({
    name: 'PROXY',
    type: 'select',
    proxies: uniqueStrings(selectorOptions)
  });

  if (groups.auto && nodeNames.length) {
    result.push({
      name: 'AUTO',
      type: 'url-test',
      url: testUrl,
      interval,
      tolerance: Number(groups.tolerance) || 50,
      proxies: nodeNames
    });
  }

  if (groups.fallback && nodeNames.length) {
    result.push({
      name: 'FALLBACK',
      type: 'fallback',
      url: testUrl,
      interval,
      proxies: nodeNames
    });
  }

  if (groups.loadBalance && nodeNames.length) {
    result.push({
      name: 'LOAD-BALANCE',
      type: 'load-balance',
      strategy: groups.strategy || 'consistent-hashing',
      url: testUrl,
      interval,
      proxies: nodeNames
    });
  }

  return result;
}

function buildRules(rules = {}, finalPolicy = 'PROXY') {
  const result = [];
  if (rules.bypassPrivate !== false) result.push(...PRIVATE_RULES);
  if (rules.blockAds) result.push(...ADS_RULES);

  result.push(...asArray(rules.custom).map((rule) => String(rule).trim()).filter(Boolean));
  result.push(`MATCH,${finalPolicy}`);
  return uniqueStrings(result);
}

function sanitizePolicy(policy, nodeNames) {
  const value = String(policy || 'PROXY').trim();
  if (['PROXY', 'DIRECT', 'REJECT'].includes(value)) return value;
  if (nodeNames.includes(value)) return value;
  return 'PROXY';
}

function sanitizeMode(mode) {
  const value = String(mode || 'rule').toLowerCase();
  return ['rule', 'global', 'direct'].includes(value) ? value : 'rule';
}

function sanitizeLogLevel(level) {
  const value = String(level || 'info').toLowerCase();
  return ['debug', 'info', 'warning', 'error', 'silent'].includes(value) ? value : 'info';
}

function normalizeNode(node = {}, index = 0, warnings = []) {
  const normalized = compactObject({
    id: node.id || makeNodeId(node.name, index),
    name: ensureNodeName(node.name, index),
    type: 'vless',
    server: node.server || node.host,
    port: Number(node.port) || 443,
    uuid: node.uuid || node.idUuid,
    udp: node.udp !== false,
    tls: node.tls !== false,
    network: node.network || 'tcp',
    servername: node.servername || node.sni || undefined,
    flow: node.flow || undefined,
    'packet-encoding': node['packet-encoding'] || node.packetEncoding || undefined,
    'client-fingerprint': node['client-fingerprint'] || node.clientFingerprint || node.fingerprint || undefined,
    'skip-cert-verify': Boolean(node['skip-cert-verify'] || node.skipCertVerify),
    'ws-opts': node['ws-opts'] || buildWsOptions(node),
    'grpc-opts': node['grpc-opts'] || buildGrpcOptions(node),
    'h2-opts': node['h2-opts'],
    'reality-opts': node['reality-opts'] || buildRealityOptions(node)
  });

  if (!normalized.server) {
    warnings.push(`Node "${normalized.name}" has no server and was kept for review.`);
  }

  if (!isUuid(normalized.uuid)) {
    warnings.push(`Node "${normalized.name}" has an invalid or missing UUID.`);
  }

  return normalized;
}

function hasNodeIdentity(node = {}) {
  return Boolean(node.server || node.host || node.uuid || node.idUuid);
}

function toMihomoProxy(node) {
  return compactObject({
    name: node.name,
    type: 'vless',
    server: node.server,
    port: node.port,
    uuid: node.uuid,
    udp: node.udp,
    tls: node.tls,
    network: node.network,
    servername: node.servername,
    flow: node.flow,
    'packet-encoding': node['packet-encoding'],
    'client-fingerprint': node['client-fingerprint'],
    'skip-cert-verify': node['skip-cert-verify'] || undefined,
    'ws-opts': node.network === 'ws' ? node['ws-opts'] : undefined,
    'grpc-opts': node.network === 'grpc' ? node['grpc-opts'] : undefined,
    'h2-opts': node.network === 'h2' ? node['h2-opts'] : undefined,
    'reality-opts': node['reality-opts']
  });
}

function buildWsOptions(node) {
  if ((node.network || 'tcp') !== 'ws') return undefined;
  return {
    path: node.wsPath || node.path || '/',
    headers: compactObject({ Host: node.wsHost || node.hostHeader || node.servername })
  };
}

function buildGrpcOptions(node) {
  if ((node.network || 'tcp') !== 'grpc') return undefined;
  return compactObject({
    'grpc-service-name': node.grpcServiceName || node.serviceName
  });
}

function buildRealityOptions(node) {
  const publicKey = node.publicKey || node.realityPublicKey;
  const shortId = node.shortId || node.realityShortId;
  if (!publicKey && !shortId) return undefined;
  return compactObject({
    'public-key': publicKey,
    'short-id': shortId
  });
}

function valueFromParam(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(String(value).toLowerCase())) return false;
  return fallback;
}

function decodeQueryValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitCsv(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function uniqueNodes(nodes) {
  const seen = new Map();
  nodes.forEach((node, index) => {
    const key = `${node.uuid || index}:${node.server || ''}:${node.port || ''}`;
    if (!seen.has(key)) {
      seen.set(key, node);
    }
  });
  return Array.from(seen.values()).map((node, index) => ({
    ...node,
    name: dedupeName(node.name, index, Array.from(seen.values()))
  }));
}

function dedupeName(name, index, allNodes) {
  const base = ensureNodeName(name, index);
  const before = allNodes.slice(0, index).filter((node) => ensureNodeName(node.name, index) === base).length;
  return before ? `${base} ${before + 1}` : base;
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function makeNodeId(name, index) {
  return `${slugify(name || 'node')}-${index + 1}`;
}

function ensureNodeName(name, index) {
  const value = String(name || '').trim();
  return value || `VLESS ${index + 1}`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'node';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    })
  );
}

function renameKeysDeep(value, aliases) {
  if (Array.isArray(value)) return value.map((item) => renameKeysDeep(item, aliases));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [aliases[key] || keyToKebab(key), renameKeysDeep(item, aliases)])
  );
}

function keyToKebab(key) {
  if (key.includes('-')) return key;
  if (!/[a-z][A-Z]/.test(key)) return key;
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((item) => formatArrayItem(item, indent)).join('\n');
  }

  if (!value || typeof value !== 'object') {
    return formatScalar(value);
  }

  const entries = Object.entries(value);
  if (!entries.length) return '{}';

  return entries.map(([key, item]) => {
    if (isScalar(item) || isEmptyCollection(item)) {
      return `${pad}${formatKey(key)}: ${formatInline(item)}`;
    }

    return `${pad}${formatKey(key)}:\n${toYaml(item, indent + 2)}`;
  }).join('\n');
}

function formatArrayItem(item, indent) {
  const pad = ' '.repeat(indent);
  if (isScalar(item) || isEmptyCollection(item)) {
    return `${pad}- ${formatInline(item)}`;
  }

  const nested = toYaml(item, indent + 2).split('\n');
  const childPad = ' '.repeat(indent + 2);
  const first = nested[0].startsWith(childPad) ? nested[0].slice(childPad.length) : nested[0];
  const rest = nested.slice(1).join('\n');
  return `${pad}- ${first}${rest ? `\n${rest}` : ''}`;
}

function formatInline(value) {
  if (Array.isArray(value)) return '[]';
  if (value && typeof value === 'object') return '{}';
  return formatScalar(value);
}

function isScalar(value) {
  return value === null || typeof value !== 'object';
}

function isEmptyCollection(value) {
  return (Array.isArray(value) && value.length === 0) || (value && typeof value === 'object' && Object.keys(value).length === 0);
}

function formatKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function maybeDecodeBase64(source) {
  const normalized = source.replace(/\s+/g, '');
  if (!normalized || normalized.includes('vless://')) return source;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(normalized)) return source;

  try {
    const padded = normalized.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return decoded.includes('vless://') ? decoded : source;
  } catch {
    return source;
  }
}
