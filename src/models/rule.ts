/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — configurable rules
 *
 *  Port of api/models/rule.server.ts + api/models/rule.ts on Kysely. All
 *  timestamps are JS numbers; the env-backed defaults (steamApiKey,
 *  steamCallbackUrl, viewerKey) resolve lazily through getRuntime() because
 *  Worker bindings are only available inside the fetch handler.
 *--------------------------------------------------------------------------------------------*/

import {
  CS2_MAX_PATCHES,
  CS2_MAX_STICKERS,
  assert,
  fail
} from "@ianlucas/cs2-lib";
import { z } from "zod";
import { db } from "../db/database";
import { getRuntime } from "../env";
import { resolveMaxAttachments } from "../lib/attachments";

class RuleFor<RuleValue> {
  constructor(private value: Promise<RuleValue>) {}

  async get() {
    return await this.value;
  }

  async truthy() {
    assert((await this.value) === true);
  }

  async notContains(what: unknown) {
    const value = await this.value;
    assert(Array.isArray(value));
    assert(!value.includes(what));
  }
}

export class Rule<RuleName extends string, RuleValue> {
  static instances: Rule<string, unknown>[] = [];
  public defaultValue: RuleValue;
  private defaultValueProvider?: () => RuleValue;
  private type: RuleValue extends string
    ? "string"
    : RuleValue extends number
      ? "number"
      : RuleValue extends boolean
        ? "boolean"
        : RuleValue extends string[]
          ? "string-array"
          : RuleValue extends number[]
            ? "number-array"
            : never;
  public name: RuleName;
  private transform?: (value: unknown) => unknown;

  constructor({
    defaultValue,
    name,
    transform,
    type
  }: {
    defaultValue: RuleValue;
    name: RuleName;
    transform?: (value: RuleValue) => RuleValue;
    type: Rule<RuleName, RuleValue>["type"];
  }) {
    this.defaultValue = defaultValue;
    this.name = name;
    this.transform = transform as ((value: unknown) => unknown) | undefined;
    this.type = type;
    Rule.instances.push(this);
  }

  /** Lazily computed default, used when no Rule row exists (env-backed rules). */
  withDefaultProvider(provider: () => RuleValue) {
    this.defaultValueProvider = provider;
    return this;
  }

  /** Runtime storage type ("string" | "number" | "boolean" | "string-array" | "number-array"). */
  describeType(): string {
    return this.type;
  }

  /** True when the value resolves from environment bindings instead of a DB row. */
  hasEnvFallback(): boolean {
    return this.defaultValueProvider !== undefined;
  }

  private async getUserRuleOverwrite(userId: string) {
    return (
      await db()
        .selectFrom("UserRule")
        .select("value")
        .where("userId", "=", userId)
        .where("name", "=", this.name)
        .executeTakeFirst()
    )?.value;
  }

  private async getUserGroupRuleOverwrite(userId: string) {
    return (
      await db()
        .selectFrom("GroupRule")
        .innerJoin("Group", "Group.id", "GroupRule.groupId")
        .innerJoin("UserGroup", "UserGroup.groupId", "Group.id")
        .select("GroupRule.value")
        .where("UserGroup.userId", "=", userId)
        .where("GroupRule.name", "=", this.name)
        .orderBy("Group.priority", "desc")
        .limit(1)
        .executeTakeFirst()
    )?.value;
  }

  private toValue(str: string): RuleValue {
    switch (this.type) {
      case "string":
        return str as RuleValue;
      case "number":
        return Number(str) as RuleValue;
      case "boolean":
        return (str === "true") as RuleValue;
      case "string-array":
        return str
          .split(";")
          .map((value) => value.trim())
          .filter((value) => value !== "") as RuleValue;
      case "number-array":
        return str
          .split(";")
          .map((value) => value.trim())
          .filter((value) => value !== "")
          .map(Number) as RuleValue;
      default:
        fail();
    }
  }

  async register() {
    const existing = await db()
      .selectFrom("Rule")
      .select("name")
      .where("name", "=", this.name)
      .executeTakeFirst();
    if (existing === undefined) {
      await this.set(this.defaultValue);
    }
  }

  async set(value: RuleValue) {
    let strValue = String(value);
    switch (this.type) {
      case "number":
        // Negative values are meaningful for the attachment limits (-1 =
        // "use the game's maximum"), so the sign is part of the grammar.
        assert(strValue.match(/^-?\d+$/) !== null);
        break;

      case "boolean":
        assert(strValue === "true" || strValue === "false");
        break;

      case "string-array": {
        const transform = z.array(z.string()).safeParse(value);
        assert(transform.success);
        strValue = transform.data.join(";");
        break;
      }

      case "number-array": {
        const transform = z.array(z.number()).safeParse(value);
        assert(transform.success);
        strValue = transform.data.join(";");
        break;
      }
    }
    await db()
      .insertInto("Rule")
      .values({
        name: this.name,
        type: this.type,
        value: strValue
      })
      .onConflict((oc) =>
        oc.columns(["name"]).doUpdateSet({
          value: strValue
        })
      )
      .execute();
  }

  /** Applies the rule's transform, if any (app/utils/attachments.ts semantics). */
  private toRuleValue(value: RuleValue): RuleValue {
    return this.transform !== undefined
      ? (this.transform(value) as RuleValue)
      : value;
  }

  async get() {
    const value = (
      await db()
        .selectFrom("Rule")
        .select("value")
        .where("name", "=", this.name)
        .executeTakeFirst()
    )?.value;
    if (value !== undefined) {
      return this.toRuleValue(this.toValue(value));
    }
    if (this.defaultValueProvider !== undefined) {
      return this.toRuleValue(this.defaultValueProvider());
    }
    return this.toRuleValue(this.defaultValue);
  }

  for(userId: string): RuleFor<RuleValue> {
    return new RuleFor(
      this.getUserRuleOverwrite(userId)
        .then((v) => v ?? this.getUserGroupRuleOverwrite(userId))
        .then((v) =>
          v !== undefined ? this.toRuleValue(this.toValue(v)) : this.get()
        )
    );
  }
}

// ---------------------------------------------------------------------------
// Rule instances (identical names/defaults to the original rule.server.ts).
// ---------------------------------------------------------------------------

export const inventoryMaxItems = new Rule({
  name: "inventoryMaxItems",
  type: "number",
  defaultValue: 256
});

export const inventoryStorageUnitMaxItems = new Rule({
  name: "inventoryStorageUnitMaxItems",
  type: "number",
  defaultValue: 32
});

export const inventoryInactivityResetDays = new Rule({
  name: "inventoryInactivityResetDays",
  type: "number",
  defaultValue: 0
});

export const appLogoUrl = new Rule({
  name: "appLogoUrl",
  type: "string",
  defaultValue: ""
});

export const appFaviconUrl = new Rule({
  name: "appFaviconUrl",
  type: "string",
  defaultValue: ""
});

export const appFaviconMimeType = new Rule({
  name: "appFaviconMimeType",
  type: "string",
  defaultValue: ""
});

export const appName = new Rule({
  name: "appName",
  type: "string",
  defaultValue: ""
});

export const appFooterName = new Rule({
  name: "appFooterName",
  type: "string",
  defaultValue: ""
});

export const appSeoDescription = new Rule({
  name: "appSeoDescription",
  type: "string",
  defaultValue: ""
});

export const appSeoImageUrl = new Rule({
  name: "appSeoImageUrl",
  type: "string",
  defaultValue: ""
});

export const appSeoTitle = new Rule({
  name: "appSeoTitle",
  type: "string",
  defaultValue: ""
});

export const appCountry = new Rule({
  name: "appCountry",
  type: "string",
  defaultValue: "us"
});

export const steamApiKey = new Rule({
  name: "steamApiKey",
  type: "string",
  defaultValue: "YOUR_STEAM_API_KEY_GOES_HERE"
}).withDefaultProvider(
  () => getRuntime().env.STEAM_API_KEY ?? "YOUR_STEAM_API_KEY_GOES_HERE"
);

export const steamCallbackUrl = new Rule({
  name: "steamCallbackUrl",
  type: "string",
  defaultValue: "http://localhost/sign-in/steam/callback"
}).withDefaultProvider(
  () =>
    getRuntime().env.STEAM_CALLBACK_URL ??
    "http://localhost/sign-in/steam/callback"
);

export const inventoryItemAllowEdit = new Rule({
  name: "inventoryItemAllowEdit",
  type: "boolean",
  defaultValue: true
});

export const craftHideCategory = new Rule({
  name: "craftHideCategory",
  type: "string-array",
  defaultValue: [] as string[]
});

export const craftHideType = new Rule({
  name: "craftHideType",
  type: "string-array",
  defaultValue: [] as string[]
});

export const craftHideFilterType = new Rule({
  name: "craftHideFilterType",
  type: "string-array",
  defaultValue: [] as string[]
});

export const craftHideModel = new Rule({
  name: "craftHideModel",
  type: "string-array",
  defaultValue: [] as string[]
});

export const craftHideId = new Rule({
  name: "craftHideId",
  type: "number-array",
  defaultValue: [] as number[]
});

export const editHideCategory = new Rule({
  name: "editHideCategory",
  type: "string-array",
  defaultValue: [] as string[]
});

export const editHideType = new Rule({
  name: "editHideType",
  type: "string-array",
  defaultValue: [] as string[]
});

export const editHideModel = new Rule({
  name: "editHideModel",
  type: "string-array",
  defaultValue: [] as string[]
});

export const editHideId = new Rule({
  name: "editHideId",
  type: "number-array",
  defaultValue: [] as number[]
});

export const inventoryItemAllowApplyPatch = new Rule({
  name: "inventoryItemAllowApplyPatch",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemAllowRemovePatch = new Rule({
  name: "inventoryItemAllowRemovePatch",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemAllowApplySticker = new Rule({
  name: "inventoryItemAllowApplySticker",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemAllowScrapeSticker = new Rule({
  name: "inventoryItemAllowScrapeSticker",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemAllowRemoveSticker = new Rule({
  name: "inventoryItemAllowRemoveSticker",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemMaxPatches = new Rule({
  name: "inventoryItemMaxPatches",
  type: "number",
  defaultValue: -1,
  transform: (value) => resolveMaxAttachments(value, CS2_MAX_PATCHES)
});

export const inventoryItemMaxStickers = new Rule({
  name: "inventoryItemMaxStickers",
  type: "number",
  defaultValue: -1,
  transform: (value) => resolveMaxAttachments(value, CS2_MAX_STICKERS)
});

export const inventoryItemAllowShare = new Rule({
  name: "inventoryItemAllowShare",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemEquipHideType = new Rule({
  name: "inventoryItemEquipHideType",
  type: "string-array",
  defaultValue: [] as string[]
});

export const inventoryItemEquipHideModel = new Rule({
  name: "inventoryItemEquipHideModel",
  type: "string-array",
  defaultValue: [] as string[]
});

export const inventoryItemAllowUnlockContainer = new Rule({
  name: "inventoryItemAllowUnlockContainer",
  type: "boolean",
  defaultValue: true
});

export const appCacheInventory = new Rule({
  name: "appCacheInventory",
  type: "boolean",
  defaultValue: true
});

export const craftAllowNametag = new Rule({
  name: "craftAllowNametag",
  type: "boolean",
  defaultValue: true
});

export const craftAllowSeed = new Rule({
  name: "craftAllowSeed",
  type: "boolean",
  defaultValue: true
});

export const craftAllowWear = new Rule({
  name: "craftAllowWear",
  type: "boolean",
  defaultValue: true
});

export const craftAllowStatTrak = new Rule({
  name: "craftAllowStatTrak",
  type: "boolean",
  defaultValue: true
});

export const craftAllowStickers = new Rule({
  name: "craftAllowStickers",
  type: "boolean",
  defaultValue: true
});

export const craftAllowPatches = new Rule({
  name: "craftAllowPatches",
  type: "boolean",
  defaultValue: true
});

export const craftMaxQuantity = new Rule({
  name: "craftMaxQuantity",
  type: "number",
  defaultValue: 0
});

export const craftAllowStickerWear = new Rule({
  name: "craftAllowStickerWear",
  type: "boolean",
  defaultValue: true
});

export const craftAllowStickerRotation = new Rule({
  name: "craftAllowStickerRotation",
  type: "boolean",
  defaultValue: true
});

export const craftAllowStickerX = new Rule({
  name: "craftAllowStickerX",
  type: "boolean",
  defaultValue: true
});

export const craftAllowStickerY = new Rule({
  name: "craftAllowStickerY",
  type: "boolean",
  defaultValue: true
});

export const craftAllowStickerSchema = new Rule({
  name: "craftAllowStickerSchema",
  type: "boolean",
  defaultValue: true
});

export const craftAllowKeychains = new Rule({
  name: "craftAllowKeychains",
  type: "boolean",
  defaultValue: true
});

export const craftAllowKeychainSeed = new Rule({
  name: "craftAllowKeychainSeed",
  type: "boolean",
  defaultValue: true
});

export const craftAllowKeychainX = new Rule({
  name: "craftAllowKeychainX",
  type: "boolean",
  defaultValue: true
});

export const craftAllowKeychainY = new Rule({
  name: "craftAllowKeychainY",
  type: "boolean",
  defaultValue: true
});

export const craftAllowKeychainZ = new Rule({
  name: "craftAllowKeychainZ",
  type: "boolean",
  defaultValue: true
});

export const editAllowNametag = new Rule({
  name: "editAllowNametag",
  type: "boolean",
  defaultValue: true
});

export const editAllowSeed = new Rule({
  name: "editAllowSeed",
  type: "boolean",
  defaultValue: true
});

export const editAllowWear = new Rule({
  name: "editAllowWear",
  type: "boolean",
  defaultValue: true
});

export const editAllowStatTrak = new Rule({
  name: "editAllowStatTrak",
  type: "boolean",
  defaultValue: true
});

export const editAllowStickers = new Rule({
  name: "editAllowStickers",
  type: "boolean",
  defaultValue: true
});

export const editAllowPatches = new Rule({
  name: "editAllowPatches",
  type: "boolean",
  defaultValue: true
});

export const inventoryItemAllowInspectInGame = new Rule({
  name: "inventoryItemAllowInspectInGame",
  type: "boolean",
  defaultValue: true
});

export const editAllowStickerWear = new Rule({
  name: "editAllowStickerWear",
  type: "boolean",
  defaultValue: true
});

export const editAllowStickerRotation = new Rule({
  name: "editAllowStickerRotation",
  type: "boolean",
  defaultValue: true
});

export const editAllowStickerX = new Rule({
  name: "editAllowStickerX",
  type: "boolean",
  defaultValue: true
});

export const editAllowStickerY = new Rule({
  name: "editAllowStickerY",
  type: "boolean",
  defaultValue: true
});

export const editAllowStickerSchema = new Rule({
  name: "editAllowStickerSchema",
  type: "boolean",
  defaultValue: true
});

export const editAllowKeychains = new Rule({
  name: "editAllowKeychains",
  type: "boolean",
  defaultValue: true
});

export const editAllowKeychainSeed = new Rule({
  name: "editAllowKeychainSeed",
  type: "boolean",
  defaultValue: true
});

export const editAllowKeychainX = new Rule({
  name: "editAllowKeychainX",
  type: "boolean",
  defaultValue: true
});

export const editAllowKeychainY = new Rule({
  name: "editAllowKeychainY",
  type: "boolean",
  defaultValue: true
});

export const editAllowKeychainZ = new Rule({
  name: "editAllowKeychainZ",
  type: "boolean",
  defaultValue: true
});

export const appHideLogo = new Rule({
  name: "appHideLogo",
  type: "boolean",
  defaultValue: false
});

export const appHideAuth = new Rule({
  name: "appHideAuth",
  type: "boolean",
  defaultValue: false
});

export const viewerEnabled = new Rule({
  name: "viewerEnabled",
  type: "boolean",
  defaultValue: false
});

export const viewerAttachmentsOnly = new Rule({
  name: "viewerAttachmentsOnly",
  type: "boolean",
  defaultValue: false
});

export const viewerKey = new Rule({
  name: "viewerKey",
  type: "string",
  defaultValue: ""
}).withDefaultProvider(() => getRuntime().env.VIEWER_KEY ?? "");

export const csFloatUrl = new Rule({
  name: "csFloatUrl",
  type: "string",
  defaultValue: ""
});

export const csFloatHeaders = new Rule({
  name: "csFloatHeaders",
  type: "string-array",
  defaultValue: []
});

export const craftAllowImportInspectLink = new Rule({
  name: "craftAllowImportInspectLink",
  type: "boolean",
  defaultValue: true
});

export const apiPublicStatTrakIncrement = new Rule({
  name: "apiPublicStatTrakIncrement",
  type: "boolean",
  defaultValue: false
});

export const apiPublicSprayConsume = new Rule({
  name: "apiPublicSprayConsume",
  type: "boolean",
  defaultValue: false
});

// ---------------------------------------------------------------------------
// getRules / getClientRules (api/models/rule.ts)
// ---------------------------------------------------------------------------

export async function setupRules() {
  return await Promise.all(
    Rule.instances.map(async (rule) => await rule.register())
  );
}

export async function getRules<T extends Record<string, Rule<string, unknown>>>(
  rules: T,
  userId?: string
): Promise<{
  [K in keyof T]: T[K]["defaultValue"];
}> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(rules).map(async ([name, rule]) => [
        name,
        userId !== undefined ? await rule.for(userId).get() : await rule.get()
      ])
    )
  );
}

export async function getClientRules(userId?: string) {
  return await getRules(
    {
      appCacheInventory,
      appFaviconMimeType,
      appFaviconUrl,
      appFooterName,
      appHideAuth,
      appHideLogo,
      appLogoUrl,
      appName,
      appSeoDescription,
      appSeoImageUrl,
      appSeoTitle,
      craftAllowImportInspectLink,
      craftAllowKeychainSeed,
      craftAllowKeychains,
      craftAllowKeychainX,
      craftAllowKeychainY,
      craftAllowKeychainZ,
      craftAllowNametag,
      craftAllowPatches,
      craftAllowSeed,
      craftAllowStatTrak,
      craftAllowStickerRotation,
      craftAllowStickers,
      craftAllowStickerSchema,
      craftAllowStickerWear,
      craftAllowStickerX,
      craftAllowStickerY,
      craftAllowWear,
      craftHideCategory,
      craftHideFilterType,
      craftHideId,
      craftHideModel,
      craftHideType,
      craftMaxQuantity,
      editAllowKeychainSeed,
      editAllowKeychains,
      editAllowKeychainX,
      editAllowKeychainY,
      editAllowKeychainZ,
      editAllowNametag,
      editAllowPatches,
      editAllowSeed,
      editAllowStatTrak,
      editAllowStickerRotation,
      editAllowStickerSchema,
      editAllowStickers,
      editAllowStickerWear,
      editAllowStickerX,
      editAllowStickerY,
      editAllowWear,
      editHideCategory,
      editHideId,
      editHideModel,
      editHideType,
      inventoryItemAllowApplyPatch,
      inventoryItemAllowApplySticker,
      inventoryItemAllowEdit,
      inventoryItemAllowInspectInGame,
      inventoryItemAllowRemovePatch,
      inventoryItemAllowRemoveSticker,
      inventoryItemAllowScrapeSticker,
      inventoryItemAllowShare,
      inventoryItemAllowUnlockContainer,
      inventoryItemEquipHideModel,
      inventoryItemEquipHideType,
      inventoryItemMaxPatches,
      inventoryItemMaxStickers,
      inventoryMaxItems,
      inventoryStorageUnitMaxItems,
      apiPublicSprayConsume,
      apiPublicStatTrakIncrement,
      viewerAttachmentsOnly,
      viewerEnabled,
      viewerKey
    },
    userId
  );
}