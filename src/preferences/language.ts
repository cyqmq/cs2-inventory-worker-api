/*---------------------------------------------------------------------------------------------
 *  CS2 Inventory Simulator — language preference
 *  Port of api/preferences/language.server.ts. When no session preference exists
 *  the language is derived from the CF-IPCountry header (falling back to the
 *  `appCountry` rule) instead of a static env value.
 *--------------------------------------------------------------------------------------------*/

import type { WorkerSession } from "../lib/session";
import { languageNames, languages, type LanguageName } from "../lib/languages";
import { appCountry } from "../models/rule";

export function isValidLanguage(language: unknown): language is LanguageName {
  return languageNames.includes(language as LanguageName);
}

function getLanguageFromCountry(countryCode: string) {
  return (
    languages.find(({ countries }) => {
      return countries.includes(countryCode);
    })?.name ?? "english"
  );
}

function getLangFromLanguage(name: string) {
  return (
    languages.find(({ name: otherName }) => {
      return otherName === name;
    })?.lang ?? "en-US"
  );
}

export async function getLanguage(
  session: WorkerSession,
  ipCountry: string | null,
  defaultLanguage?: string | null
) {
  const country = (ipCountry || (await appCountry.get())).toLowerCase();
  const language =
    (session.get("language") as string | null | undefined) ||
    defaultLanguage ||
    getLanguageFromCountry(country);
  return {
    lang: getLangFromLanguage(language),
    language
  };
}