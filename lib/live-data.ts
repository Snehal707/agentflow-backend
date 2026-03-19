/**
 * Fetches structured live context for the research agent before calling Hermes.
 * CoinGecko is used for current token market metrics.
 * DefiLlama is used for chain-level TVL and stablecoin liquidity.
 * GDELT is used for current-event and geopolitical article context.
 * DuckDuckGo is used for lightweight background context and descriptive snippets.
 */

type ResearchDomain = 'crypto' | 'geopolitics' | 'general';

type CoinGeckoAssetSnapshot = {
  symbol: string;
  coinId: string;
  price_usd?: number;
  market_cap_usd?: number;
  volume_24h_usd?: number;
  change_24h_pct?: number;
  last_updated_at?: string;
};

type DuckDuckGoSnapshot = {
  query: string;
  abstract?: string;
  answer?: string;
  definition?: string;
  related_topics?: string[];
};

type WikipediaPageSnapshot = {
  title: string;
  description?: string;
  summary?: string;
  url?: string;
  last_updated_at?: string;
};

type GdeltArticleSnapshot = {
  title: string;
  url: string;
  article_url?: string;
  domain?: string;
  publisher?: string;
  language?: string;
  source_country?: string;
  seen_at?: string;
};

type DefiLlamaChainSnapshot = {
  chain: string;
  tvl_usd?: number;
  stablecoins_usd?: number;
  stablecoins_change_1d_usd?: number;
  stablecoins_change_1d_pct?: number;
  top_stablecoins?: Array<{
    symbol: string;
    name: string;
    circulating_usd: number;
  }>;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const LIVE_DATA_FETCH_TIMEOUT_MS = 4_000;
const LIVE_DATA_CACHE_TTL_MS = 60_000;
const COINGECKO_CACHE_TTL_MS = 30_000;
const DEFILLAMA_CACHE_TTL_MS = 300_000;
const DUCKDUCKGO_CACHE_TTL_MS = 120_000;
const GDELT_CACHE_TTL_MS = 120_000;
const NEWS_RSS_CACHE_TTL_MS = 120_000;
const WIKIPEDIA_CACHE_TTL_MS = 300_000;
const GDELT_MIN_INTERVAL_MS = 6_000;

const liveDataCache = new Map<string, CacheEntry<string>>();
const coinGeckoCache = new Map<string, CacheEntry<CoinGeckoAssetSnapshot[]>>();
const duckDuckGoCache = new Map<string, CacheEntry<DuckDuckGoSnapshot | null>>();
const gdeltCache = new Map<string, CacheEntry<GdeltArticleSnapshot[]>>();
const newsRssCache = new Map<string, CacheEntry<GdeltArticleSnapshot[]>>();
const wikipediaCache = new Map<string, CacheEntry<WikipediaPageSnapshot[]>>();

let defillamaChainsCache: CacheEntry<Array<{ name?: string; tvl?: number }>> | null =
  null;
let defillamaStablecoinsCache: CacheEntry<{
  peggedAssets?: Array<{
    name?: string;
    symbol?: string;
    chainCirculating?: Record<
      string,
      {
        current?: { peggedUSD?: number };
        circulatingPrevDay?: { peggedUSD?: number };
      }
    >;
  }>;
}> | null = null;
let gdeltNextAllowedAt = 0;

const COIN_KEYWORDS: Array<{ pattern: RegExp; coinId: string; symbol: string }> = [
  { pattern: /\bbitcoin\b|\bbtc\b/i, coinId: 'bitcoin', symbol: 'BTC' },
  { pattern: /\bethereum\b|\beth\b/i, coinId: 'ethereum', symbol: 'ETH' },
  { pattern: /\bsolana\b|\bsol\b/i, coinId: 'solana', symbol: 'SOL' },
  { pattern: /\bbase\b/i, coinId: 'ethereum', symbol: 'ETH' },
  { pattern: /\busdc\b|\busd coin\b/i, coinId: 'usd-coin', symbol: 'USDC' },
  { pattern: /\btether\b|\busdt\b/i, coinId: 'tether', symbol: 'USDT' },
  { pattern: /\bdai\b/i, coinId: 'dai', symbol: 'DAI' },
];

const COIN_TO_CHAIN_TARGET: Record<string, string> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum',
  solana: 'Solana',
};

const CHAIN_KEYWORDS: Array<{ pattern: RegExp; chain: string }> = [
  { pattern: /\bethereum\b|\beth\b/i, chain: 'Ethereum' },
  { pattern: /\bsolana\b|\bsol\b/i, chain: 'Solana' },
  { pattern: /\bbase\b/i, chain: 'Base' },
  { pattern: /\barbitrum\b/i, chain: 'Arbitrum' },
  { pattern: /\boptimism\b|\bop mainnet\b/i, chain: 'OP Mainnet' },
  { pattern: /\bpolygon\b|\bmatic\b/i, chain: 'Polygon' },
  { pattern: /\bavalanche\b|\bavax\b/i, chain: 'Avalanche' },
  { pattern: /\bbsc\b|\bbnb chain\b|\bbinance smart chain\b/i, chain: 'BSC' },
  { pattern: /\btron\b|\btrx\b/i, chain: 'Tron' },
  { pattern: /\bsui\b/i, chain: 'Sui' },
  { pattern: /\baptos\b/i, chain: 'Aptos' },
  { pattern: /\bbitcoin\b|\bbtc\b/i, chain: 'Bitcoin' },
];

const GEOPOLITICS_KEYWORDS: RegExp[] = [
  /\bwar\b/i,
  /\bconflict\b/i,
  /\bmilitary\b/i,
  /\bstrike\b/i,
  /\bairstrike\b/i,
  /\bmissile\b/i,
  /\bsanction/i,
  /\bproxy\b/i,
  /\bceasefire\b/i,
  /\bgeopolitic/i,
  /\brisk assessment\b/i,
  /\btroops?\b/i,
  /\bnuclear\b/i,
  /\biran\b/i,
  /\bisrael\b/i,
  /\bgaza\b/i,
  /\bhamas\b/i,
  /\bhezbollah\b/i,
  /\brussia\b/i,
  /\bukraine\b/i,
  /\bchina\b/i,
  /\btaiwan\b/i,
  /\bunited states\b/i,
  /\busa\b/i,
  /\bu\.s\.?\b/i,
];

const TRUSTED_CURRENT_EVENT_SOURCES: Array<{
  pattern: RegExp;
  score: number;
}> = [
  { pattern: /\bassociated press\b|\bap news\b|apnews\.com/i, score: 100 },
  { pattern: /\breuters\b|reuters\.com/i, score: 95 },
  { pattern: /\bun\b|\bunited nations\b|un\.org/i, score: 92 },
  { pattern: /\bdefense\.gov\b|\bpentagon\b/i, score: 90 },
  { pattern: /\bstate\.gov\b/i, score: 90 },
  { pattern: /\baxios\b/i, score: 86 },
  { pattern: /\bnytimes\b|\bnew york times\b/i, score: 82 },
  { pattern: /\bwashington post\b/i, score: 80 },
  { pattern: /\bthe guardian\b/i, score: 76 },
  { pattern: /\bcouncil on foreign relations\b|\bcfr\b/i, score: 72 },
  { pattern: /\batlantic council\b/i, score: 68 },
];

function getCacheValue<T>(entry: CacheEntry<T> | null | undefined): T | null {
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) return null;
  return entry.value;
}

function setTimedCache<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): T {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function fetchJsonWithTimeout<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(LIVE_DATA_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}: ${url}`);
  }

  return (await response.json()) as T;
}

async function fetchTextWithTimeout(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(LIVE_DATA_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}: ${url}`);
  }

  return response.text();
}

function detectResearchDomain(task: string): ResearchDomain {
  const cryptoHits =
    COIN_KEYWORDS.filter((item) => item.pattern.test(task)).length +
    CHAIN_KEYWORDS.filter((item) => item.pattern.test(task)).length +
    (/\bcrypto\b|\bcoin\b|\btoken\b|\bdefi\b|\bstablecoin\b|\bmarket cap\b/i.test(task)
      ? 2
      : 0);

  const geopoliticsHits = GEOPOLITICS_KEYWORDS.filter((pattern) =>
    pattern.test(task),
  ).length;

  if (geopoliticsHits > cryptoHits && geopoliticsHits >= 2) {
    return 'geopolitics';
  }

  if (cryptoHits > 0) {
    return 'crypto';
  }

  return 'general';
}

function pickCoinTargets(task: string): Array<{ coinId: string; symbol: string }> {
  const matches = COIN_KEYWORDS.filter((item) => item.pattern.test(task)).map(
    (item) => ({
      coinId: item.coinId,
      symbol: item.symbol,
    }),
  );

  const deduped = new Map<string, { coinId: string; symbol: string }>();
  for (const item of matches) {
    deduped.set(item.coinId, item);
  }

  if (deduped.size > 0) {
    return [...deduped.values()].slice(0, 5);
  }

  if (/\bcrypto\b|\bcoin\b|\btoken\b|\bmarket cap\b|\bstablecoin\b/i.test(task)) {
    return [
      { coinId: 'bitcoin', symbol: 'BTC' },
      { coinId: 'ethereum', symbol: 'ETH' },
      { coinId: 'solana', symbol: 'SOL' },
    ];
  }

  return [];
}

function pickChainTargets(task: string): string[] {
  const deduped = new Set<string>();

  for (const item of CHAIN_KEYWORDS) {
    if (item.pattern.test(task)) {
      deduped.add(item.chain);
    }
  }

  if (deduped.size === 0) {
    for (const item of pickCoinTargets(task)) {
      const chain = COIN_TO_CHAIN_TARGET[item.coinId];
      if (chain) deduped.add(chain);
    }
  }

  return [...deduped].slice(0, 5);
}

function unixToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function gdeltTimestampToIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  ).toISOString();
}

function buildGdeltQuery(task: string): string {
  const cleaned = task.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? `${cleaned} sourcelang:english` : 'sourcelang:english';
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').trim();
}

function truncateSentences(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;

  const truncated = normalized.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('! '),
  );

  if (lastSentenceEnd > 120) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }

  return `${truncated.trim()}...`;
}

function currentEventSourceScore(article: GdeltArticleSnapshot): number {
  const haystack = [
    article.publisher,
    article.domain,
    article.url,
    article.title,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const source of TRUSTED_CURRENT_EVENT_SOURCES) {
    if (source.pattern.test(haystack)) {
      return source.score;
    }
  }

  return 10;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function titleFromWikipediaUrl(url: string): string | null {
  const match = url.match(/\/wiki\/([^?#]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function pickWikipediaQueries(task: string, domain: ResearchDomain): string[] {
  if (domain === 'crypto') {
    const entityQueries = new Set<string>();
    for (const coin of pickCoinTargets(task)) {
      if (coin.coinId === 'bitcoin') entityQueries.add('Bitcoin');
      if (coin.coinId === 'ethereum') entityQueries.add('Ethereum');
      if (coin.coinId === 'solana') entityQueries.add('Solana');
      if (coin.coinId === 'usd-coin') entityQueries.add('USD Coin');
    }
    for (const chain of pickChainTargets(task)) {
      entityQueries.add(chain);
    }
    return [...entityQueries].slice(0, 2);
  }

  if (domain === 'geopolitics') {
    const queries = new Set<string>();
    queries.add(task);
    queries.add(task.replace(/\brisk assessment\b/i, '').trim());

    if (/\biran\b/i.test(task) && /\bunited states\b|\busa\b|\bu\.s\.?\b/i.test(task)) {
      queries.add('Iran-United States relations');
    }

    if (/\brussia\b/i.test(task) && /\bukraine\b/i.test(task)) {
      queries.add('Russia-Ukraine conflict');
    }

    return [...queries].filter(Boolean).slice(0, 2);
  }

  return [
    task,
    task
      .replace(/^\s*(what is|what are|who is|who are|explain|define)\s+/i, '')
      .replace(/\?+$/, '')
      .trim(),
  ]
    .filter(Boolean)
    .slice(0, 1);
}

async function fetchCoinGeckoData(task: string): Promise<CoinGeckoAssetSnapshot[]> {
  const targets = pickCoinTargets(task);
  if (targets.length === 0) return [];

  const ids = targets.map((item) => item.coinId).join(',');
  const cacheKey = ids;
  const cached = getCacheValue(coinGeckoCache.get(cacheKey));
  if (cached) {
    return cached;
  }

  const json = await fetchJsonWithTimeout<
    Record<
      string,
      {
        usd?: number;
        usd_market_cap?: number;
        usd_24h_vol?: number;
        usd_24h_change?: number;
        last_updated_at?: number;
      }
    >
  >(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      ids,
    )}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`,
  );

  const snapshots: CoinGeckoAssetSnapshot[] = [];

  for (const target of targets) {
    const row = json[target.coinId];
    if (!row) continue;

    snapshots.push({
      symbol: target.symbol,
      coinId: target.coinId,
      price_usd: row.usd,
      market_cap_usd: row.usd_market_cap,
      volume_24h_usd: row.usd_24h_vol,
      change_24h_pct: row.usd_24h_change,
      last_updated_at: unixToIso(row.last_updated_at),
    });
  }

  return setTimedCache(coinGeckoCache, cacheKey, snapshots, COINGECKO_CACHE_TTL_MS);
}

async function fetchDefiLlamaData(task: string): Promise<DefiLlamaChainSnapshot[]> {
  const targets = pickChainTargets(task);
  if (targets.length === 0) return [];

  let chainsJson = getCacheValue(defillamaChainsCache);
  if (!chainsJson) {
    chainsJson = await fetchJsonWithTimeout<Array<{ name?: string; tvl?: number }>>(
      'https://api.llama.fi/v2/chains',
    );
    defillamaChainsCache = {
      value: chainsJson,
      expiresAt: Date.now() + DEFILLAMA_CACHE_TTL_MS,
    };
  }

  let stablecoinsJson = getCacheValue(defillamaStablecoinsCache);
  if (!stablecoinsJson) {
    stablecoinsJson = await fetchJsonWithTimeout<{
      peggedAssets?: Array<{
        name?: string;
        symbol?: string;
        chainCirculating?: Record<
          string,
          {
            current?: { peggedUSD?: number };
            circulatingPrevDay?: { peggedUSD?: number };
          }
        >;
      }>;
    }>('https://stablecoins.llama.fi/stablecoins');
    defillamaStablecoinsCache = {
      value: stablecoinsJson,
      expiresAt: Date.now() + DEFILLAMA_CACHE_TTL_MS,
    };
  }

  const chainRows = new Map<string, { name?: string; tvl?: number }>();
  for (const row of chainsJson) {
    if (typeof row.name === 'string' && row.name) {
      chainRows.set(row.name.toLowerCase(), row);
    }
  }

  const peggedAssets = Array.isArray(stablecoinsJson.peggedAssets)
    ? stablecoinsJson.peggedAssets
    : [];

  const snapshots: DefiLlamaChainSnapshot[] = [];

  for (const target of targets) {
    const chainRow = chainRows.get(target.toLowerCase());
    let stablecoinsUsd = 0;
    let stablecoinsPrevDayUsd = 0;
    const topStablecoins: Array<{
      symbol: string;
      name: string;
      circulating_usd: number;
    }> = [];

    for (const asset of peggedAssets) {
      const chainData = asset.chainCirculating?.[target];
      const current = chainData?.current?.peggedUSD;
      const prevDay = chainData?.circulatingPrevDay?.peggedUSD;

      if (typeof current === 'number' && Number.isFinite(current) && current > 0) {
        stablecoinsUsd += current;
        topStablecoins.push({
          symbol: asset.symbol || asset.name || 'UNKNOWN',
          name: asset.name || asset.symbol || 'Unknown',
          circulating_usd: current,
        });
      }

      if (typeof prevDay === 'number' && Number.isFinite(prevDay) && prevDay > 0) {
        stablecoinsPrevDayUsd += prevDay;
      }
    }

    topStablecoins.sort((a, b) => b.circulating_usd - a.circulating_usd);

    const change1dUsd =
      stablecoinsPrevDayUsd > 0 ? stablecoinsUsd - stablecoinsPrevDayUsd : undefined;
    const change1dPct =
      stablecoinsPrevDayUsd > 0
        ? ((stablecoinsUsd - stablecoinsPrevDayUsd) / stablecoinsPrevDayUsd) * 100
        : undefined;

    if (
      typeof chainRow?.tvl !== 'number' &&
      stablecoinsUsd === 0 &&
      topStablecoins.length === 0
    ) {
      continue;
    }

    snapshots.push({
      chain: target,
      tvl_usd: chainRow?.tvl,
      stablecoins_usd: stablecoinsUsd > 0 ? stablecoinsUsd : undefined,
      stablecoins_change_1d_usd: change1dUsd,
      stablecoins_change_1d_pct: change1dPct,
      top_stablecoins: topStablecoins.slice(0, 3),
    });
  }

  return snapshots;
}

function flattenDuckDuckGoTopics(
  topics: unknown,
  bucket: string[],
  limit = 5,
): void {
  if (!Array.isArray(topics) || bucket.length >= limit) return;

  for (const topic of topics) {
    if (bucket.length >= limit) return;

    if (
      topic &&
      typeof topic === 'object' &&
      'Text' in topic &&
      typeof (topic as { Text?: unknown }).Text === 'string'
    ) {
      bucket.push((topic as { Text: string }).Text);
      continue;
    }

    if (topic && typeof topic === 'object' && 'Topics' in topic) {
      flattenDuckDuckGoTopics((topic as { Topics?: unknown }).Topics, bucket, limit);
    }
  }
}

async function fetchDuckDuckGoData(task: string): Promise<DuckDuckGoSnapshot | null> {
  const query = task.trim();
  if (!query) return null;

  const cachedEntry = duckDuckGoCache.get(query);
  const cached = getCacheValue(cachedEntry);
  if (cachedEntry && Date.now() < cachedEntry.expiresAt) {
    return cached;
  }

  const json = await fetchJsonWithTimeout<{
    AbstractText?: string;
    Answer?: string;
    Definition?: string;
    RelatedTopics?: unknown;
  }>(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query,
    )}&format=json&no_html=1&skip_disambig=1`,
  );

  const relatedTopics: string[] = [];
  flattenDuckDuckGoTopics(json.RelatedTopics, relatedTopics);

  const snapshot: DuckDuckGoSnapshot = {
    query,
    abstract: json.AbstractText?.trim() || undefined,
    answer: json.Answer?.trim() || undefined,
    definition: json.Definition?.trim() || undefined,
    related_topics: relatedTopics.length > 0 ? relatedTopics : undefined,
  };

  if (
    !snapshot.abstract &&
    !snapshot.answer &&
    !snapshot.definition &&
    !snapshot.related_topics?.length
  ) {
    duckDuckGoCache.set(query, {
      value: null,
      expiresAt: Date.now() + DUCKDUCKGO_CACHE_TTL_MS,
    });
    return null;
  }

  return setTimedCache(duckDuckGoCache, query, snapshot, DUCKDUCKGO_CACHE_TTL_MS);
}

async function fetchWikipediaData(
  task: string,
  domain: ResearchDomain,
): Promise<WikipediaPageSnapshot[]> {
  const cacheKey = `${domain}:${task.trim().toLowerCase()}`;
  const cached = getCacheValue(wikipediaCache.get(cacheKey));
  if (cached) {
    return cached;
  }

  const queries = pickWikipediaQueries(task, domain);
  const pages = new Map<string, WikipediaPageSnapshot>();

  for (const query of queries) {
    if (!query.trim()) continue;

    const search = await fetchJsonWithTimeout<
      [string, string[], string[], string[]]
    >(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
        query,
      )}&limit=3&namespace=0&format=json&origin=*`,
    ).catch(() => null);

    const urls = Array.isArray(search?.[3]) ? search[3] : [];
    for (const url of urls) {
      if (typeof url !== 'string') continue;
      const title = titleFromWikipediaUrl(url);
      if (!title || pages.has(title)) continue;

      const summary = await fetchJsonWithTimeout<{
        title?: string;
        displaytitle?: string;
        description?: string;
        extract?: string;
        timestamp?: string;
        content_urls?: { desktop?: { page?: string } };
      }>(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      ).catch(() => null);

      if (!summary) continue;

      const description = summary.description?.trim();
      if (
        /index of articles associated with the same name/i.test(description || '') ||
        /\bdisambiguation\b/i.test(summary.title || '')
      ) {
        continue;
      }

      pages.set(title, {
        title: stripHtml(summary.displaytitle || summary.title || title),
        description,
        summary: truncateSentences(summary.extract, 420),
        url: summary.content_urls?.desktop?.page || url,
        last_updated_at: summary.timestamp,
      });

      if (pages.size >= 2) break;
    }

    if (pages.size >= 2) break;
  }

  return setTimedCache(
    wikipediaCache,
    cacheKey,
    [...pages.values()].slice(0, 2),
    WIKIPEDIA_CACHE_TTL_MS,
  );
}

async function fetchGdeltData(task: string): Promise<GdeltArticleSnapshot[]> {
  const query = task.trim().toLowerCase();
  if (!query) return [];

  const cached = getCacheValue(gdeltCache.get(query));
  if (cached) {
    return cached;
  }

  if (Date.now() < gdeltNextAllowedAt) {
    return [];
  }

  gdeltNextAllowedAt = Date.now() + GDELT_MIN_INTERVAL_MS;

  const json = await fetchJsonWithTimeout<{
    articles?: Array<{
      url?: string;
      title?: string;
      seendate?: string;
      domain?: string;
      language?: string;
      sourcecountry?: string;
    }>;
  }>(
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
      buildGdeltQuery(task),
    )}&mode=artlist&maxrecords=6&sort=DateDesc&format=json`,
  );

  const articles = Array.isArray(json.articles) ? json.articles : [];
  const snapshots = articles
    .filter(
      (article): article is Required<Pick<typeof article, 'title' | 'url'>> &
        typeof article =>
        typeof article.title === 'string' && typeof article.url === 'string',
    )
    .filter((article) => !article.language || /english/i.test(article.language))
    .map((article) => ({
      title: article.title,
      url: article.url,
      domain: article.domain,
      language: article.language,
      source_country: article.sourcecountry,
      seen_at: gdeltTimestampToIso(article.seendate),
    }))
    .sort((a, b) => currentEventSourceScore(b) - currentEventSourceScore(a))
    .slice(0, 3);

  return setTimedCache(gdeltCache, query, snapshots, GDELT_CACHE_TTL_MS);
}

async function fetchGoogleNewsRssData(task: string): Promise<GdeltArticleSnapshot[]> {
  const query = task.trim().toLowerCase();
  if (!query) return [];

  const cached = getCacheValue(newsRssCache.get(query));
  if (cached) {
    return cached;
  }

  const xml = await fetchTextWithTimeout(
    `https://news.google.com/rss/search?q=${encodeURIComponent(
      task,
    )}&hl=en-US&gl=US&ceid=US:en`,
  );

  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const snapshots: GdeltArticleSnapshot[] = [];

  for (const match of itemBlocks) {
    const block = match[1];
    const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    const rawLink = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1];
    const rawPubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1];
    const rawSourceUrl = block.match(/<source\s+url="([^"]+)"/i)?.[1];
    const rawSourceName = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1];

    if (!rawTitle || !rawLink) continue;

    const title = decodeXmlEntities(rawTitle.trim());
    const link = decodeXmlEntities(rawLink.trim());
    const sourceUrl = rawSourceUrl ? decodeXmlEntities(rawSourceUrl.trim()) : undefined;
    const lastSeparator = title.lastIndexOf(' - ');
    const publisher = rawSourceName
      ? decodeXmlEntities(rawSourceName.trim())
      : lastSeparator > 0
        ? title.slice(lastSeparator + 3).trim()
        : undefined;
    const cleanTitle =
      lastSeparator > 0 ? title.slice(0, lastSeparator).trim() : title;
    const publishedAt = rawPubDate ? new Date(rawPubDate).toISOString() : undefined;

    snapshots.push({
      title: cleanTitle,
      url: sourceUrl || link,
      article_url: sourceUrl ? link : undefined,
      publisher,
      seen_at: publishedAt,
      language: 'English',
    });
  }

  snapshots.sort((a, b) => currentEventSourceScore(b) - currentEventSourceScore(a));

  return setTimedCache(
    newsRssCache,
    query,
    snapshots.slice(0, 3),
    NEWS_RSS_CACHE_TTL_MS,
  );
}

async function fetchCurrentEventsData(task: string): Promise<GdeltArticleSnapshot[]> {
  const gdelt = await fetchGdeltData(task).catch(() => []);
  if (gdelt.length > 0) {
    return gdelt;
  }

  return fetchGoogleNewsRssData(task).catch(() => []);
}

export async function fetchLiveData(task: string): Promise<string> {
  const normalizedTask = task.trim().toLowerCase();
  const cached = getCacheValue(liveDataCache.get(normalizedTask));
  if (cached) {
    return cached;
  }

  const snapshotAt = new Date().toISOString();
  const researchDomain = detectResearchDomain(task);
  const payload: Record<string, unknown> = {
    snapshot_at: snapshotAt,
    research_domain: researchDomain,
  };

  if (researchDomain === 'crypto') {
    const [coingecko, defillama, duckduckgo, wikipedia] = await Promise.allSettled([
      fetchCoinGeckoData(task),
      fetchDefiLlamaData(task),
      fetchDuckDuckGoData(task),
      fetchWikipediaData(task, researchDomain),
    ]);

    if (coingecko.status === 'fulfilled' && coingecko.value.length > 0) {
      payload.coingecko = {
        source: 'CoinGecko simple price API',
        assets: coingecko.value,
      };
    }

    if (defillama.status === 'fulfilled' && defillama.value.length > 0) {
      payload.defillama = {
        source: 'DefiLlama chains API + stablecoins API',
        chains: defillama.value,
      };
    }

    if (duckduckgo.status === 'fulfilled' && duckduckgo.value) {
      payload.duckduckgo = {
        source: 'DuckDuckGo instant answer API',
        ...duckduckgo.value,
      };
    }

    if (wikipedia.status === 'fulfilled' && wikipedia.value.length > 0) {
      payload.wikipedia = {
        source: 'Wikipedia OpenSearch + REST summary API',
        pages: wikipedia.value,
      };
    }
  } else if (researchDomain === 'geopolitics') {
    const [currentEvents, duckduckgo, wikipedia] = await Promise.allSettled([
      fetchCurrentEventsData(task),
      fetchDuckDuckGoData(task),
      fetchWikipediaData(task, researchDomain),
    ]);

    if (currentEvents.status === 'fulfilled' && currentEvents.value.length > 0) {
      payload.current_events = {
        source: 'GDELT document API with Google News RSS fallback',
        articles: currentEvents.value,
      };
    }

    if (duckduckgo.status === 'fulfilled' && duckduckgo.value) {
      payload.duckduckgo = {
        source: 'DuckDuckGo instant answer API',
        ...duckduckgo.value,
      };
    }

    if (wikipedia.status === 'fulfilled' && wikipedia.value.length > 0) {
      payload.wikipedia = {
        source: 'Wikipedia OpenSearch + REST summary API',
        pages: wikipedia.value,
      };
    }
  } else {
    const [duckduckgo, wikipedia] = await Promise.all([
      fetchDuckDuckGoData(task).catch(() => null),
      fetchWikipediaData(task, researchDomain).catch(() => [] as WikipediaPageSnapshot[]),
    ]);
    if (duckduckgo) {
      payload.duckduckgo = {
        source: 'DuckDuckGo instant answer API',
        ...duckduckgo,
      };
    }

    if (wikipedia.length > 0) {
      payload.wikipedia = {
        source: 'Wikipedia OpenSearch + REST summary API',
        pages: wikipedia,
      };
    }
  }

  const hasSourceData = Boolean(
    payload.coingecko ||
      payload.defillama ||
      payload.duckduckgo ||
      payload.wikipedia ||
      payload.gdelt ||
      payload.current_events,
  );
  const result = hasSourceData ? JSON.stringify(payload, null, 2) : '';

  if (normalizedTask) {
    liveDataCache.set(normalizedTask, {
      value: result,
      expiresAt: Date.now() + LIVE_DATA_CACHE_TTL_MS,
    });
  }

  return result;
}
