/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — database row types
 *
 *  Table/column names mirror the original Prisma schema
 *  (cs2-inventory-serverapi/prisma/schema.prisma). Timestamps are JS numbers
 *  (unix epoch milliseconds); D1 stores them as INTEGER, PostgreSQL as
 *  DOUBLE PRECISION — Kysely sees an identical `number` on both backends.
 *--------------------------------------------------------------------------------------------*/

export interface UserRow {
  id: string;
  avatar: string;
  name: string;
  inventory: string | null;
  inventoryVersion: number;
  lastSeen: number;
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserCacheRow {
  url: string;
  userId: string;
  args: string | null;
  body: string;
  timestamp: number;
}

export interface UserPreferenceRow {
  userId: string;
  background: string | null;
  hideFilters: string | null;
  hideFreeItems: string | null;
  hideNewItemLabel: string | null;
  language: string | null;
  prefer2dStickerEditor: string | null;
  statsForNerds: string | null;
}

export interface ApiCredentialRow {
  apiKey: string;
  comment: string | null;
  scope: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiAuthTokenRow {
  token: string;
  apiKey: string;
  userId: string;
  createdAt: number;
}

export interface RuleRow {
  name: string;
  type: string;
  value: string;
}

export interface UserRuleRow {
  name: string;
  userId: string;
  value: string;
}

export interface GroupRow {
  id: string;
  priority: number;
}

export interface UserGroupRow {
  groupId: string;
  userId: string;
}

export interface GroupRuleRow {
  groupId: string;
  name: string;
  value: string;
}

export interface Database {
  User: UserRow;
  UserCache: UserCacheRow;
  UserPreference: UserPreferenceRow;
  ApiCredential: ApiCredentialRow;
  ApiAuthToken: ApiAuthTokenRow;
  Rule: RuleRow;
  UserRule: UserRuleRow;
  Group: GroupRow;
  UserGroup: UserGroupRow;
  GroupRule: GroupRuleRow;
}