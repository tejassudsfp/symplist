import { SearchScreen } from "@/features/search/search-screen";

/**
 * Full search across task titles, current documents and (when the owner opts in) chat (search.md).
 * The query and filters live in the client only, so no query text ever reaches the address bar,
 * browser history or a server log (note 14).
 */
export default function SearchPage() {
  return <SearchScreen />;
}
