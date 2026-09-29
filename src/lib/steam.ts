/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — Steam OpenID + user profile helpers
 *
 *  Port of @ianlucas/remix-auth-steam (SteamOpenID + SteamStrategy) and the
 *  steamapi getUserSummary call used by the original strategies. React-router's
 *  `redirect()` is replaced with plain Response redirects.
 *--------------------------------------------------------------------------------------------*/

import { getRuntime } from "../env";

/** Fetch the user's Steam profile. Falls back to defaults when the summary is
 *  unavailable (bad key, rate limit, private profile) so sign-in still works. */
export interface SteamUserInput {
  steamID: string;
  nickname: string;
  avatar: { medium: string };
}

export async function fetchSteamUserInput(steamId: string): Promise<SteamUserInput> {
  const apiKey = getRuntime().env.STEAM_API_KEY;
  let player:
    | { steamid: string; personaname?: string; avatarmedium?: string }
    | undefined;
  if (apiKey !== undefined && apiKey.length > 0) {
    try {
      const url = new URL(
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/"
      );
      url.searchParams.set("key", apiKey);
      url.searchParams.set("steamids", steamId);
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(15_000)
      });
      if (response.ok) {
        const body = (await response.json()) as {
          response?: { players?: { steamid: string; personaname?: string; avatarmedium?: string }[] };
        };
        player = body.response?.players?.[0];
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return {
    steamID: steamId,
    nickname: player?.personaname ?? "Player",
    avatar: { medium: player?.avatarmedium ?? "" }
  };
}

export class SteamOpenID {
  static SERVER = "https://steamcommunity.com/openid/login";
  static OPENID_NS = "http://specs.openid.net/auth/2.0";
  static EXPECTED_SIGNED =
    "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle";
  static STEAM_ID_REGEX = /^https:\/\/steamcommunity\.com\/openid\/id\/(76561[0-9]{12})\/?$/;

  returnUrl: string;
  params: URLSearchParams;

  constructor(returnUrl: string, request: Request) {
    const parsed = new URL(returnUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("ReturnURL must start with https:// or http://");
    }
    if (!parsed.hostname) {
      throw new Error("ReturnURL must contain a host.");
    }
    if (!parsed.pathname || parsed.pathname === "/") {
      throw new Error("ReturnURL must contain a path to prevent prefix attacks.");
    }
    this.returnUrl = returnUrl;
    this.params = new URL(request.url).searchParams;
  }

  shouldValidate() {
    return this.params.get("openid.mode") === "id_res";
  }

  getAuthUrl() {
    const params = new URLSearchParams({
      "openid.ns": SteamOpenID.OPENID_NS,
      "openid.mode": "checkid_setup",
      "openid.return_to": this.returnUrl,
      "openid.identity":
        "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.claimed_id":
        "http://specs.openid.net/auth/2.0/identifier_select"
    });
    return `${SteamOpenID.SERVER}?${params.toString()}`;
  }

  async validate(): Promise<string> {
    const args = this.getAndValidateArguments();

    if (args["openid.op_endpoint"] !== SteamOpenID.SERVER) {
      throw new Error('Invalid "openid.op_endpoint".');
    }
    if (!args["openid.return_to"]?.startsWith(this.returnUrl)) {
      throw new Error('Invalid "openid.return_to".');
    }

    const nonceMatch = args["openid.response_nonce"]?.match(
      /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)/
    );
    if (!nonceMatch || !nonceMatch[1]) {
      throw new Error('Invalid "openid.response_nonce" format.');
    }
    const nonceTime = new Date(nonceMatch[1]).getTime();
    if (isNaN(nonceTime) || Math.abs(Date.now() - nonceTime) > 300_000) {
      throw new Error("Nonce timestamp is too old or invalid.");
    }

    const match = args["openid.identity"]?.match(SteamOpenID.STEAM_ID_REGEX);
    if (!match || !match[1]) {
      throw new Error('Invalid "openid.identity".');
    }
    const steamId = match[1];

    const verificationParams = new URLSearchParams(args);
    verificationParams.set("openid.mode", "check_authentication");
    const response = await this.sendVerificationRequest(verificationParams);
    const keyValues = SteamOpenID.parseKeyValues(response);
    if (
      keyValues["is_valid"] !== "true" ||
      keyValues["ns"] !== SteamOpenID.OPENID_NS
    ) {
      throw new Error("Failed to validate login with Steam: Invalid response.");
    }
    return steamId;
  }

  async sendVerificationRequest(params: URLSearchParams) {
    const response = await fetch(SteamOpenID.SERVER, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "TypeScript-SteamOpenID/1.0.0"
      },
      body: params
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error(
          "Steam OpenID endpoint is rate-limited. Please try again later."
        );
      }
      throw new Error(
        `Steam verification request failed with HTTP ${response.status}.`
      );
    }
    return response.text();
  }

  getAndValidateArguments(): Record<string, string> {
    const args: Record<string, string> = {};
    const signedKeys = SteamOpenID.EXPECTED_SIGNED.split(",");
    for (const key of signedKeys) {
      const openIdKey = `openid.${key}`;
      const value = this.params.get(openIdKey);
      if (!value) {
        throw new Error(`Missing required OpenID parameter: "${openIdKey}".`);
      }
      args[openIdKey] = value;
    }
    const otherRequiredKeys = ["openid.mode", "openid.sig", "openid.ns"];
    for (const key of otherRequiredKeys) {
      const value = this.params.get(key);
      if (!value) {
        throw new Error(`Missing required OpenID parameter: "${key}".`);
      }
      args[key] = value;
    }
    if (args["openid.mode"] !== "id_res") {
      throw new Error('Invalid "openid.mode". Expected "id_res".');
    }
    if (args["openid.ns"] !== SteamOpenID.OPENID_NS) {
      throw new Error('Invalid "openid.ns".');
    }
    if (args["openid.signed"] !== SteamOpenID.EXPECTED_SIGNED) {
      throw new Error('Invalid "openid.signed" field.');
    }
    return args;
  }

  static parseKeyValues(response: string): Record<string, string> {
    const data: Record<string, string> = {};
    const lines = response.trim().split("\n");
    for (const line of lines) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex !== -1) {
        const key = line.substring(0, separatorIndex);
        const value = line.substring(separatorIndex + 1);
        data[key] = value;
      }
    }
    return data;
  }
}