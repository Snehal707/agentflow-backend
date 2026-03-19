const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID;
const GA_API_SECRET = process.env.GA_API_SECRET;

interface GAEventParams {
  [key: string]: unknown;
}

export async function sendGAEvent(
  name: string,
  params: GAEventParams = {},
): Promise<void> {
  if (!GA_MEASUREMENT_ID || !GA_API_SECRET) return;

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

  const body = {
    client_id: (params.wallet_address as string) || "server",
    events: [
      {
        name,
        params: {
          ...params,
        },
      },
    ],
  };

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Analytics failures should never break main flow
  }
}

