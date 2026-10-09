export interface DiscordMessageReceipt {
  readonly id: string;
  readonly channelID: string;
}

export interface DiscordTextConnectorOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

export class DiscordTextConnector {
  readonly #token: string;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: DiscordTextConnectorOptions) {
    if (!options.token.trim()) throw new Error('Discord bot token is required');
    this.#token = options.token;
    this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://discord.com/api/v10').replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async sendMessage(channelID: string, content: string): Promise<DiscordMessageReceipt> {
    if (!/^\d{17,20}$/.test(channelID)) throw new Error('Discord channel ID is invalid');
    if (!content.trim() || content.length > 2_000) {
      throw new Error('Discord message must contain between 1 and 2000 characters');
    }

    const response = await this.#fetch(`${this.#apiBaseUrl}/channels/${channelID}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bot ${this.#token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      throw new Error(`Discord message failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: unknown; channel_id?: unknown };
    if (typeof body.id !== 'string' || typeof body.channel_id !== 'string') {
      throw new Error('Discord returned an invalid message receipt');
    }
    return { id: body.id, channelID: body.channel_id };
  }
}
