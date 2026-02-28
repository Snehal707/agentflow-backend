/**
 * Fetches live data (crypto + DuckDuckGo) for research agent before calling Hermes.
 */

export async function fetchLiveData(task: string): Promise<string> {
  const liveData: string[] = [];
  try {
    if (/bitcoin|btc|ethereum|eth|crypto|coin/i.test(task)) {
      const r = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_market_cap=true&include_24hr_change=true',
      );
      const d = await r.json();
      liveData.push('LIVE CRYPTO DATA: ' + JSON.stringify(d));
    }
    const query = encodeURIComponent(task);
    const r2 = await fetch(
      `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`,
    );
    const d2 = (await r2.json()) as { AbstractText?: string };
    if (d2.AbstractText) {
      liveData.push('LATEST INFO: ' + d2.AbstractText);
    }
  } catch (e) {
    console.log('Live data fetch failed:', e);
  }
  return liveData.join('\n');
}
