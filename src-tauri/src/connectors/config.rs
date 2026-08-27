//! Registry of supported connectors.
//!
//! Each `Connector` is a small config record: the OAuth endpoints, the remote
//! MCP server URL, and a display name + icon hint. Adding a connector is a
//! matter of appending an entry here (plus any vendor-specific auth quirks
//! noted in BUILD_LOG.md) — the credential store, OAuth flow, MCP
//! client, permission gating, and UI are all generic and driven off this.

use serde::Serialize;

pub type ConnectorId = &'static str;

/// One supported connector. The fields below are the *only* per-connector
/// data — everything else (credential storage, OAuth webview, MCP client,
/// approval gating) is framework code reused across all connectors.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    /// Stable id, also the `connector_credentials.connector_id` primary key.
    pub id: ConnectorId,
    pub display_name: &'static str,
    /// Glyph or emoji for the settings card; the frontend may also ship an
    /// icon image keyed off `id`.
    pub icon: &'static str,
    /// Group (product family) this connector is displayed under in Settings.
    /// Connectors that share one vendor product and OAuth client/consent (e.g.
    /// every Google Workspace MCP server) collapse into a single family card
    /// titled with the family's real brand logo, with the individual products
    /// as rows beneath it. Single-member families (Notion) render as one card.
    pub family: &'static str,
    /// One-sentence capability summary. Shown in the system-prompt manifest so
    /// the model can decide whether to attach this connector on demand
    /// (`attach_connector`) — the full tool schemas are NOT sent until then.
    pub description: &'static str,
    /// Lowercase trigger phrases for the send-time relevance fast-path
    /// (`chat::prompts::detect_connector_mentions`). Matched as word-boundary
    /// substrings against the lowercased user message; a hit attaches the
    /// connector without the model needing the `attach_connector` hop.
    pub keywords: &'static [&'static str],
    /// OAuth 2.0 authorization endpoint (browser points here for login+consent).
    pub authorize_url: &'static str,
    /// Token exchange + refresh endpoint.
    pub token_url: &'static str,
    /// OAuth client id registered with the vendor. Notion is a *confidential*
    /// client (client secret required at token exchange) — see BUILD_LOG.md
    /// for the desktop-embedding caveat this implies.
    pub client_id: &'static str,
    pub client_secret: &'static str,
    /// Redirect URI registered with the vendor. For the loopback callback
    /// server in `oauth.rs` this MUST be an `http://localhost:<fixed-port>/…`
    /// URL that is also registered verbatim in the vendor's dashboard —
    /// Notion does strict string matching and rejects dynamic/unregistered
    /// ports (see BUILD_LOG.md).
    pub redirect_uri: &'static str,
    /// Space-separated scope strings sent in the authorize URL. Notion ignores
    /// this (its scopes are dashboard-configured capabilities, not URL
    /// parameters) but other vendors use it — included here for generality.
    pub scopes: &'static str,
    /// The vendor's remote MCP server URL. Registered into a session's tool
    /// set when the connector is attached; its tools come from `tools/list`.
    pub mcp_server_url: &'static str,
    /// Optional RFC 7591 dynamic client registration endpoint. When present,
    /// `oauth::start` registers (once, persisted under the app data dir) an
    /// OAuth client at this endpoint and uses THAT client for authorize /
    /// token / refresh / revoke. Needed when the authorization server
    /// validates clients against its own registry at the callback + token
    /// hops and rejects clients registered elsewhere — mcp.notion.com is
    /// exactly this (its authorize hop proxies any client_id, but the
    /// callback and token hops reject unknown ones with "Unknown OAuth
    /// client" / `invalid_client: Client not found`).
    pub registration_url: Option<&'static str>,
    /// Optional OAuth 2.0 token revocation endpoint. When present, Disconnect
    /// calls it after clearing the local token; when absent (Notion),
    /// Disconnect only forgets the token locally. Logged per-connector in
    /// BUILD_LOG.md.
    pub revoke_url: Option<&'static str>,
}

impl Connector {
    /// Whether this connector is a confidential client (exchanges the code
    /// with `Authorization: Basic base64(client_id:client_secret)` rather than
    /// PKCE-only). All current entries are confidential; PKCE is still
    /// generated as defense-in-depth where the vendor tolerates it.
    pub fn confidential(&self) -> bool {
        !self.client_secret.is_empty()
    }

    /// Whether this connector authenticates against Google's OAuth endpoints
    /// (every Google Workspace MCP connector shares the same "Desktop app"
    /// client supplied via `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
    /// Google's authorization server only issues a refresh token when
    /// `access_type=offline` is in the authorize URL, so `oauth::build_authorize_url`
    /// keys its URL extras off this rather than enumerating connector ids.
    pub fn is_google(&self) -> bool {
        self.token_url == "https://oauth2.googleapis.com/token"
    }

    /// Whether this connector has NO OAuth flow — its MCP server is publicly
    /// accessible and needs no credentials, consent, or token store. Keyed off
    /// the empty `authorize_url`. Kiwi.com's official flight-search MCP server
    /// (`https://mcp.kiwi.com`) is the only one today: verified live with a
    /// full `initialize` + `tools/list` + `tools/call` handshake.
    pub fn is_public(&self) -> bool {
        self.authorize_url.is_empty()
    }

    /// The MCP server URL to actually connect to. Currently the static
    /// `mcp_server_url` for every connector; kept as a method so future
    /// env-assembled URLs (like the retired Merge Agent Handler's
    /// tool-pack/registered-user path segments) don't leak into `mcp.rs`.
    pub fn effective_mcp_server_url(&self) -> String {
        self.mcp_server_url.to_string()
    }

    /// Whether this connector's credentials are present and usable. Public
    /// connectors (Kiwi) need nothing, and connectors that register their
    /// OAuth client at runtime (Notion, Canva) are always configured —
    /// Connect just runs the registration + flow. Statically-credentialed
    /// connectors (Google, GitHub) are configured only when their build-time
    /// `client_id` env var was set; Connect fails fast with a helpful message
    /// otherwise (see `oauth::resolve_oauth_client`).
    pub fn configured(&self) -> bool {
        if self.is_public() || self.registration_url.is_some() {
            return true;
        }
        !self.client_id.is_empty()
    }
}

/// `Deserialize` is needed only for the test that round-trips the registry; the
/// runtime path reads it as `Serialize` to send to the frontend.
#[cfg(test)]
impl<'de> serde::Deserialize<'de> for Connector {
    fn deserialize<D: serde::Deserializer<'de>>(_d: D) -> Result<Self, D::Error> {
        unreachable!("Connector is constructed statically, not deserialized")
    }
}

/// Notion — the first connector, built to validate the framework.
///
/// Notion-specific quirks (vs. generic framework code), logged in BUILD_LOG.md:
/// - The remote MCP server at mcp.notion.com is itself an OAuth resource
///   server (RFC 8707) with its OWN authorization/token endpoints
///   (discovered via .well-known/oauth-authorization-server). The REST-API
///   OAuth endpoints (api.notion.com/v1/oauth/...) mint tokens that the MCP
///   server REJECTS ("invalid_token"). mcp.notion.com/authorize accepts any
///   client_id, proxies the login through the standard Notion consent screen
///   (using its own registered callback https://mcp.notion.com/callback),
///   and finally redirects to OUR redirect_uri with the code. Exchange that
///   code at mcp.notion.com/token — it mints a token valid for the MCP
///   resource.
/// - The MCP authorization server validates OAuth clients against ITS OWN
///   registry at the callback + token hops (authorize proxies blindly).
///   `registration_url` enables RFC 7591 dynamic client registration; the
///   registered client (public, PKCE, no secret) is persisted under the app
///   data dir and reused. The api.notion.com public-connection
///   `client_id`/`client_secret` env vars are NOT usable here — Notion's AS
///   rejects them ("Unknown OAuth client" at callback, `invalid_client:
///   Client not found` at token). They are kept on the connector record for
///   legacy/informational purposes.
/// - Tokens are short-lived (~1 hour) with rotating refresh tokens; the MCP
///   AS requires `application/x-www-form-urlencoded` token/refresh/revoke
///   requests (JSON is rejected). Revocation is RFC 7009-style at /token.
/// - PKCE S256 is REQUIRED by the MCP AS (plain also supported) — our code
///   always sends `code_challenge`/`code_challenge_method=S256`.
/// - Auth header for the MCP server is a standard `Authorization: Bearer`.

/// Read a `&'static str` from a build-time env var, falling back to `""` when
/// unset (so unconfigured builds compile and surface a clear runtime error in
/// `oauth::start` rather than panicking at const-eval). Mirrors the pattern
/// used for other build-time secrets; kept local to this module. Defined
/// before the `NOTION` const because macros are resolved textually before use.
macro_rules! env_or_empty {
    ($name:literal) => {
        match option_env!($name) {
            Some(v) => v,
            None => "",
        }
    };
}

/// Fixed loopback port for Notion's OAuth callback. Registered verbatim in the
/// Notion developer portal (Configuration → OAuth redirect URIs) and must
/// match `NOTION.redirect_uri`. Chosen below the Windows ephemeral range
/// (49152+) to minimize collisions with OS-assigned ports.
pub const NOTION_CALLBACK_PORT: u16 = 45123;

pub const NOTION: Connector = Connector {
    id: "notion",
    display_name: "Notion",
    icon: "📓",
    family: "notion",
    description: "Search, read, create, and update pages, databases, and notes in the user's Notion workspace.",
    keywords: &["notion", "my notes", "my pages", "notion page", "notion database"],
    // The remote MCP server at mcp.notion.com is itself an OAuth resource
    // server (RFC 8707) with its OWN authorization/token endpoints
    // (discovered via .well-known/oauth-authorization-server). The REST-API
    // OAuth endpoints (api.notion.com/v1/oauth/...) mint tokens that the MCP
    // server REJECTS ("invalid_token"). mcp.notion.com/authorize accepts the
    // same api.notion.com public-connection client_id, proxies the login
    // through the standard Notion consent screen (using its own registered
    // callback https://mcp.notion.com/callback), and finally redirects to
    // OUR redirect_uri with the code. Exchange that code at
    // mcp.notion.com/token — it mints a token valid for the MCP resource.
    authorize_url: "https://mcp.notion.com/authorize",
    token_url: "https://mcp.notion.com/token",
    client_id: env_or_empty!("NOTION_CLIENT_ID"),
    client_secret: env_or_empty!("NOTION_CLIENT_SECRET"),
    // Notion does strict exact-string matching on registered redirect URIs:
    // only `https://` or `http://localhost` are accepted, and loopback URIs
    // must use a FIXED pre-registered port (dynamic ports are rejected — see
    // BUILD_LOG.md). The system-browser flow binds a loopback listener on
    // this exact port, so the URL must be registered verbatim in the Notion
    // developer portal. Keep in sync with `NOTION_CALLBACK_PORT`.
    redirect_uri: "http://localhost:45123/oauth/callback",
    scopes: "",
    mcp_server_url: "https://mcp.notion.com/mcp",
    // The MCP authorization server advertises its revocation endpoint at the
    // token endpoint (see the .well-known metadata above).
    revoke_url: Some("https://mcp.notion.com/token"),
    // RFC 7591 dynamic client registration: the MCP AS validates clients
    // against its own registry at the callback + token hops, so we register
    // our loopback redirect_uri there (once) and authenticate with that
    // client. Verified live: the api.notion.com public-connection client is
    // rejected ("Unknown OAuth client" / invalid_client), and unregistered
    // ids fail registration requests only when the request body is malformed.
    registration_url: Some("https://mcp.notion.com/register"),
};

/// Gmail — Google's hosted Gmail MCP server.
///
/// Google-specific quirks (vs. generic framework code), logged in BUILD_LOG.md:
/// - Google does NOT support dynamic client registration (RFC 7591) nor
///   client id metadata documents — the connector MUST use a statically
///   registered OAuth client (created in Google Cloud Console, "Desktop app"
///   type), supplied via `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` build
///   env vars (same pattern as the Notion client used before DCR).
/// - The "Desktop app" client type accepts loopback redirects on ANY local
///   port (RFC 8252 §7.3), so the fixed-port redirect_uri below needs no
///   explicit registration — but keep it consistent with `GMAIL_CALLBACK_PORT`
///   (the loopback server binds that exact port).
/// - Google's token endpoint requires `application/x-www-form-urlencoded`
///   bodies and accepts `client_secret_basic` (Basic header) — the static
///   confidential branch in `oauth.rs` sends exactly that.
/// - The authorize URL needs `access_type=offline&prompt=consent` or no
///   refresh token is issued (and none is issued on repeat consents without
///   `prompt=consent`); `oauth::build_authorize_url` adds both for every
///   connector where `is_google()` is true (this one + the Workspace set
///   below).
/// - Scopes are URL strings: `gmail.modify` (read + compose + label/thread
///   modification; still excludes permanent deletion). The scope is a
///   RESTRICTED scope: the OAuth app works unverified for test users, but
///   public distribution requires Google's app verification.
/// - The Gmail MCP server (`gmailmcp.googleapis.com`) is a Developer Preview;
///   the project must enable `gmailmcp.googleapis.com` (may require Google
///   Workspace Developer Preview Program enrollment).
/// - Tokens: ~1 hour access + rotating refresh (handled generically).
/// - No revocation endpoint configured — Disconnect forgets the token locally
///   (Google's /revoke may be added later once verified).
pub const GMAIL_CALLBACK_PORT: u16 = 45124;

pub const GMAIL: Connector = Connector {
    id: "gmail",
    display_name: "Gmail",
    icon: "✉️",
    family: "google",
    description: "Search, read, draft, send, and manage the user's Gmail email.",
    keywords: &["gmail", "my email", "my inbox", "email thread", "draft an email", "send an email", "send email"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45124/oauth/callback",
    scopes: "https://www.googleapis.com/auth/gmail.modify",
    mcp_server_url: "https://gmailmcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

/// Google Workspace MCP connectors — Drive, Docs, Sheets, Slides, Calendar,
/// Chat and People, all hosted by Google at `*.googleapis.com/mcp/v1`.
///
/// Shared quirks (vs. generic framework code), logged in BUILD_LOG.md:
/// - Same OAuth setup as Gmail: one statically registered "Desktop app" OAuth
///   client in Google Cloud Console supplied via `GOOGLE_CLIENT_ID` /
///   `GOOGLE_CLIENT_SECRET`; loopback redirects are accepted on ANY local
///   port (RFC 8252 §7.3), but each connector has its own fixed
///   `*_CALLBACK_PORT` below so independent flows never collide.
/// - Each service's MCP API must be enabled in the Cloud project before its
///   server responds (`drivemcp.googleapis.com`, `docsmcp.googleapis.com`,
///   `sheetsmcp.googleapis.com`, `slidesmcp.googleapis.com`,
///   `calendarmcp.googleapis.com`, `chatmcp.googleapis.com`,
///   `people.googleapis.com` — Gmail's `gmailmcp.googleapis.com` is already
///   enabled). The MCP services are Developer Preview and may require
///   Workspace Developer Preview Program enrollment, like Gmail.
/// - Scopes below are the WRITE-capable set (Google's own docs list read-only
///   variants first; the write tools — update_doc, update_spreadsheet,
///   create_event/delete_event, send_message, ... — only work with the
///   non-readonly scopes). Downgrading to `*.readonly` restricts the connector
///   to read-only tool surfaces. Several are RESTRICTED scopes: the OAuth app
///   works unverified for test users, but public distribution requires
///   Google's app verification.
/// - Capability notes (per Google's tool references): Drive is create/copy +
///   read only — it has NO update or delete tools; Docs/Sheets/Slides delete
///   content (rows, ranges, elements) inside their `update_*` batch tools but
///   cannot delete whole files; Calendar is the only full CRUD (incl.
///   `delete_event`); Chat reads + sends (no delete); People is read-only.
/// - Tokens: ~1 hour access + rotating refresh, handled generically; no
///   revocation endpoint configured (Disconnect forgets the token locally,
///   same as Gmail).
pub const GOOGLE_DRIVE_CALLBACK_PORT: u16 = 45125;
pub const GOOGLE_DOCS_CALLBACK_PORT: u16 = 45126;
pub const GOOGLE_SHEETS_CALLBACK_PORT: u16 = 45127;
pub const GOOGLE_SLIDES_CALLBACK_PORT: u16 = 45128;
pub const GOOGLE_CALENDAR_CALLBACK_PORT: u16 = 45129;
pub const GOOGLE_CHAT_CALLBACK_PORT: u16 = 45130;
pub const GOOGLE_PEOPLE_CALLBACK_PORT: u16 = 45131;

pub const GOOGLE_DRIVE: Connector = Connector {
    id: "gdrive",
    display_name: "Google Drive",
    icon: "🗂️",
    family: "google",
    description: "Search, read, and create files stored in the user's Google Drive.",
    keywords: &["google drive", "my drive", "drive file", "gdrive"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45125/oauth/callback",
    // `drive.readonly` (search/read any file) + `drive.file` (create/copy —
    //   the server has no update/delete tools, so file-scoped access is enough).
    scopes: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
    mcp_server_url: "https://drivemcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

pub const GOOGLE_DOCS: Connector = Connector {
    id: "gdocs",
    display_name: "Google Docs",
    icon: "📝",
    family: "google",
    description: "Read and edit text documents in Google Docs.",
    keywords: &["google doc", "google docs", "gdoc"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45126/oauth/callback",
    // Full `documents` scope: `read_doc` + `update_doc` (batchUpdate incl.
    //   insert/delete of text, tables, images, comments, ...).
    scopes: "https://www.googleapis.com/auth/documents",
    mcp_server_url: "https://docsmcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

pub const GOOGLE_SHEETS: Connector = Connector {
    id: "gsheets",
    display_name: "Google Sheets",
    icon: "📊",
    family: "google",
    description: "Read and edit spreadsheets in Google Sheets.",
    keywords: &["google sheet", "google sheets", "gsheet", "spreadsheet in my"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45127/oauth/callback",
    // Full `spreadsheets` scope: values + structural batch updates (add/delete
    //   sheets, rows, ranges).
    scopes: "https://www.googleapis.com/auth/spreadsheets",
    mcp_server_url: "https://sheetsmcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

pub const GOOGLE_SLIDES: Connector = Connector {
    id: "gslides",
    display_name: "Google Slides",
    icon: "📽️",
    family: "google",
    description: "Read and edit presentations in Google Slides.",
    keywords: &["google slide", "google slides", "gslide"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45128/oauth/callback",
    // Full `presentations` scope: `read_presentation` + `update_presentation`
    //   (create/delete slides, shapes, text, ...).
    scopes: "https://www.googleapis.com/auth/presentations",
    mcp_server_url: "https://slidesmcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

pub const GOOGLE_CALENDAR: Connector = Connector {
    id: "gcalendar",
    display_name: "Google Calendar",
    icon: "📅",
    family: "google",
    description: "Read, create, update, and delete events and calendars in Google Calendar.",
    keywords: &["google calendar", "my calendar", "calendar event", "my events", "my schedule", "my meetings", "gcal"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45129/oauth/callback",
    // `calendar.events` (full CRUD on events — the only Google connector with
    //   a true delete tool) + `calendar.calendarlist.readonly` (`list_calendars`
    //   reads the calendarList).
    scopes: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    mcp_server_url: "https://calendarmcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

pub const GOOGLE_CHAT: Connector = Connector {
    id: "gchat",
    display_name: "Google Chat",
    icon: "💬",
    family: "google",
    description: "Read and send messages in Google Chat spaces.",
    keywords: &["google chat", "gchat", "chat space"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45130/oauth/callback",
    // Read (spaces/messages/memberships/read-state) + `chat.messages.create`
    //   for `send_message`. The chat.* scopes are RESTRICTED — Google app
    //   verification is required beyond test users.
    scopes: "https://www.googleapis.com/auth/chat.messages.create https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.memberships.readonly https://www.googleapis.com/auth/chat.users.readstate.readonly",
    mcp_server_url: "https://chatmcp.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

pub const GOOGLE_PEOPLE: Connector = Connector {
    id: "gpeople",
    display_name: "Google People",
    icon: "👥",
    family: "google",
    description: "Look up the user's Google contacts and directory profiles.",
    keywords: &["my contacts", "google contacts", "contact info for", "directory"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45131/oauth/callback",
    // Read-only by design: get_user_profile, search_contacts,
    //   search_directory_people — no write tools exist on this server.
    scopes: "https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/directory.readonly https://www.googleapis.com/auth/userinfo.profile",
    mcp_server_url: "https://people.googleapis.com/mcp/v1",
    revoke_url: None,
    registration_url: None,
};

/// YouTube — Data API v3 via the Google family OAuth token.
///
/// Google ships NO hosted MCP server for YouTube (nothing in the Workspace
/// MCP Developer Preview covers it), so this connector runs ENTIRELY on its
/// local REST fallback tools (`google_rest::YOUTUBE_TOOLS`, base
/// `https://www.googleapis.com/youtube/v3`): `mcp_server_url` is empty and
/// the session-attach path attaches fallback-only connectors when their MCP
/// connect fails (see `session::connect_all`). Read-only by design:
/// `youtube.readonly` covers search plus reads of the user's own channel,
/// playlists and playlist items without any write reach.
pub const YOUTUBE_CALLBACK_PORT: u16 = 45134;

pub const YOUTUBE: Connector = Connector {
    id: "youtube",
    display_name: "YouTube",
    icon: "▶",
    // Standalone family — NOT "google": YouTube has no hosted MCP server and
    // its scope cannot ride the Workspace combined consent (Google 400s the
    // mix), so it renders as its own card with its own single-scope Connect
    // flow beside the other connectors.
    family: "youtube",
    description: "Search YouTube videos/channels/playlists and read your channel, playlists, playlists and video stats.",
    keywords: &["youtube", "my videos", "my channel", "my playlists", "search youtube", "video stats", "watch later"],
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: env_or_empty!("GOOGLE_CLIENT_ID"),
    client_secret: env_or_empty!("GOOGLE_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45134/oauth/callback",
    // Read-only: youtube.readonly grants search plus reads of the user's own
    // channel/playlists/playlist items with no write reach.
    scopes: "https://www.googleapis.com/auth/youtube.readonly",
    mcp_server_url: "",
    revoke_url: None,
    registration_url: None,
};

/// Kiwi.com — the official public flight-search MCP server
/// (`https://mcp.kiwi.com`, server `kiwicom-flight-search`), launched by
/// Kiwi.com in 2025 and listed in AltexSoft's Travel MCP Provider Index.
///
/// Kiwi-specific quirks (vs. the OAuth framework):
/// - PUBLIC endpoint: no OAuth, no API key, no registration. Verified live
///   with a full `initialize` + `tools/list` + `tools/call` handshake — the
///   server exposes two tools: `search-flight` (read-only, idempotent;
///   resolves city names or IATA codes, ±3-day date flexibility, passengers,
///   cabin class, currency, ~30 filters) and `feedback-to-devs`.
/// - Booking is link-out: each itinerary carries a `bookingUrl` deep-link
///   into kiwi.com; there is no in-API ticketing.
/// - Free to use — no per-call billing, no quota.
pub const KIWI: Connector = Connector {
    id: "kiwi",
    display_name: "Kiwi.com",
    icon: "🥝",
    family: "kiwi",
    description: "Search flights and itineraries with booking links via Kiwi.com.",
    keywords: &["kiwi", "flight search", "find flights", "flights from", "flights to", "cheapest flight", "plane ticket"],
    // No OAuth and no key: public endpoint — `is_public()` signals "no OAuth
    // flow" and `configured()` always returns true for it.
    authorize_url: "",
    token_url: "",
    client_id: "",
    client_secret: "",
    redirect_uri: "",
    scopes: "",
    mcp_server_url: "https://mcp.kiwi.com",
    revoke_url: None,
    registration_url: None,
};

/// GitHub — the official hosted GitHub MCP server
/// (`https://api.githubcopilot.com/mcp/`, operated by GitHub on
/// github-copilot.com infra), giving the agent repo/issue/PR/code access.
///
/// GitHub-specific quirks (vs. generic framework code), logged in BUILD_LOG.md:
/// - The MCP endpoint is an RFC 9728 OAuth resource server: unauthenticated
///   requests get a 401 with `WWW-Authenticate` pointing at
///   `.well-known/oauth-protected-resource`, whose metadata names the
///   authorization server `https://github.com/login/oauth` (GitHub's classic
///   OAuth App endpoints) and the scopes it accepts (repo, read:org,
///   read:user, user:email, read:packages, ...). GitHub publishes no
///   authorization-server metadata and no dynamic client registration — the
///   connector MUST use a statically registered GitHub OAuth App supplied via
///   `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` build-time env vars (same
///   pattern as the Google client).
/// - The OAuth App's single callback URL must be registered verbatim in the
///   app settings; we register the fixed-port loopback URI below.
/// - GitHub OAuth App tokens never expire and GitHub issues NO refresh token
///   for them, so the stored `expires_at` stays `None` and the refresh path is
///   never triggered (a token is invalidated only by revoking the app grant in
///   GitHub settings). There is also no public revoke endpoint — Disconnect
///   forgets the token locally (same note as Google).
/// - GitHub OAuth Apps do not implement PKCE; the extra `code_challenge`
///   params our generic authorize URL always sends are ignored by GitHub.
/// - The scope set requested at authorize time gates which tools the server
///   exposes (the resource metadata lists `repo read:org read:user user:email`
///   as the useful baseline); narrower grants surface fewer tools.
pub const GITHUB_CALLBACK_PORT: u16 = 45133;

pub const GITHUB: Connector = Connector {
    id: "github",
    display_name: "GitHub",
    icon: "🐙",
    family: "github",
    description: "Access GitHub repositories, issues, pull requests, and code.",
    keywords: &["github", "my pull request", "pull request on", "issue on github", "my repos", "github repo"],
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    client_id: env_or_empty!("GITHUB_CLIENT_ID"),
    client_secret: env_or_empty!("GITHUB_CLIENT_SECRET"),
    redirect_uri: "http://localhost:45133/oauth/callback",
    scopes: "repo read:org read:user user:email",
    mcp_server_url: "https://api.githubcopilot.com/mcp/",
    revoke_url: None,
    registration_url: None,
};

/// Canva — the official hosted Canva MCP server
/// (`https://mcp.canva.com/mcp`), giving the agent design creation, editing,
/// asset/folder/brand management, and export tools.
///
/// **DISABLED** (kept for re-enabling later): Canva requires its redirect URI
/// to be allowlisted via their waitlist form before ANY request body to
/// `/register` is accepted (verified live — every body shape returns
/// "Invalid JSON payload" until approval). Not in `CONNECTORS`, so it never
/// reaches the Settings UI. Re-enable by appending `CANVA` to `CONNECTORS`
/// once the waitlist approval lands.
///
/// Canva-specific quirks (vs. generic framework code), logged in BUILD_LOG.md:
/// - The MCP endpoint is an RFC 9728 OAuth resource server; its
///   authorization-server metadata (`/.well-known/oauth-authorization-server`)
///   advertises `/authorize`, `/token`, `/register`, revocation at `/token`,
///   and token auth methods `client_secret_basic|post|none` (verified live).
/// - Dynamic client registration is supported but DEPRECATED in favor of
///   Client ID Metadata Documents (client_id = an HTTPS URL to a client
///   description — no secret). We use the DCR endpoint (`/register`) via the
///   generic `registration_url` machinery (Notion pattern), caching the
///   registered public client under the app data dir.
/// - Per-user authentication: every Canva account authorizes individually
///   (no org/service account) — the OAuth consent screen does this.
/// - The `generate-design` tool can take ~60 s; MCP tool calls must not time
///   out below that (see the MCP call timeout note in mcp.rs).
pub const CANVA_CALLBACK_PORT: u16 = 45134;

pub const CANVA: Connector = Connector {
    id: "canva",
    display_name: "Canva",
    icon: "🎨",
    family: "canva",
    description: "Create and edit designs, assets, and brand templates in Canva.",
    keywords: &["canva", "canva design"],
    authorize_url: "https://mcp.canva.com/authorize",
    token_url: "https://mcp.canva.com/token",
    // Public client registered at runtime via `registration_url` — no static
    // credentials needed (PKCE S256, no secret).
    client_id: "",
    client_secret: "",
    redirect_uri: "http://localhost:45134/oauth/callback",
    // The write-capable set covering design create/edit, folders, assets,
    // comments, brand templates, and brand kits (see the resource metadata's
    // scopes_supported). `help:*` is intentionally excluded.
    scopes: "profile:read design:meta:read design:content:read design:content:write folder:read folder:write asset:read asset:write comment:read comment:write brandtemplate:meta:read brandtemplate:content:read brandkit:read",
    mcp_server_url: "https://mcp.canva.com/mcp",
    // The authorization server advertises revocation at the token endpoint.
    revoke_url: Some("https://mcp.canva.com/token"),
    registration_url: Some("https://mcp.canva.com/register"),
};

/// All supported connectors, in the order they appear in the Settings UI.
pub const CONNECTORS: &[Connector] = &[
    NOTION,
    GMAIL,
    GOOGLE_DRIVE,
    GOOGLE_DOCS,
    GOOGLE_SHEETS,
    GOOGLE_SLIDES,
    GOOGLE_CALENDAR,
    GOOGLE_CHAT,
    GOOGLE_PEOPLE,
    YOUTUBE,
    KIWI,
    GITHUB,
];

// ---- family (group) connect ----

/// Google family members: one OAuth client, one consent screen. `start_family`
/// in `oauth.rs` runs a single authorize/exchange flow with the COMBINED
/// scopes and stores the resulting token under every member's credential row,
/// so one "Connect" click connects all of them.
/// Google family members: one OAuth client, one consent screen. `start_family`
/// in `oauth.rs` runs a single authorize/exchange flow with the COMBINED
/// scopes and stores the resulting token under every member's credential row,
/// so one "Connect" click connects all of them.
///
/// YouTube is deliberately NOT a member. MEASURED (2026-08-27, twice): Google
/// rejects the combined consent with `Error 400: invalid_request` the moment
/// `youtube.readonly` joins the other 16 scopes — even with the YouTube Data
/// API v3 enabled on the project, and even though the SAME scope authorizes
/// fine in a YouTube-only request for the same client. Google enforces some
/// limit on mixing YouTube scopes with this (unverified, Workspace-restricted)
/// scope set in one consent. YouTube therefore connects through its OWN
/// single-connector flow (its row's Connect button); once granted, the stored
/// token makes it read as connected like any other member.
pub const GOOGLE_FAMILY_MEMBERS: &[&Connector] = &[
    &GMAIL,
    &GOOGLE_DRIVE,
    &GOOGLE_DOCS,
    &GOOGLE_SHEETS,
    &GOOGLE_SLIDES,
    &GOOGLE_CALENDAR,
    &GOOGLE_CHAT,
    &GOOGLE_PEOPLE,
];

/// Loopback callback for the family flow. Google's "Desktop app" client type
/// accepts loopback redirects on ANY local port (RFC 8252 §7.3), so this needs
/// no explicit registration — keep it distinct from every member port so a
/// member flow and the family flow never fight for the same listener.
pub const GOOGLE_FAMILY_CALLBACK_PORT: u16 = 45132;
pub const GOOGLE_FAMILY_REDIRECT_URI: &str = "http://localhost:45132/oauth/callback";

/// The members of a connector family (for family connect), if any.
pub fn family_members(family: &str) -> Option<&'static [&'static Connector]> {
    match family {
        "google" => Some(GOOGLE_FAMILY_MEMBERS),
        _ => None,
    }
}

/// The loopback callback URI used by a family's combined OAuth flow.
pub fn family_redirect_uri(family: &str) -> Option<&'static str> {
    match family {
        "google" => Some(GOOGLE_FAMILY_REDIRECT_URI),
        _ => None,
    }
}

pub fn connector_by_id(id: &str) -> Option<&'static Connector> {
    CONNECTORS.iter().find(|c| c.id == id)
}

/// Human-facing reason a connector has no OAuth flow, for the Connect button
/// (Kiwi's server is public, so there is nothing to configure).
pub fn no_oauth_flow_reason(c: &Connector) -> String {
    format!(
        "{} has no OAuth flow — its MCP server is public and needs no \
         credentials; attach it to a chat to use its tools.",
        c.display_name
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notion_is_registered() {
        let n = connector_by_id("notion").expect("notion registered");
        assert_eq!(n.mcp_server_url, "https://mcp.notion.com/mcp");
        assert!(n.revoke_url.is_some()); // MCP AS advertises revocation at /token
        assert!(n.scopes.is_empty()); // Notion: dashboard-configured, not URL
        // The OAuth endpoints are the MCP server's OWN authorization server
        // (mcp.notion.com), not the REST API's — the latter mints tokens the
        // MCP resource rejects (verified live, see BUILD_LOG.md).
        assert_eq!(n.authorize_url, "https://mcp.notion.com/authorize");
        assert_eq!(n.token_url, "https://mcp.notion.com/token");
        // `confidential()` reflects whether a client_secret is configured; the
        // shipped default is empty (filled at build time before the e2e test),
        // so we assert the *intent* — Notion uses Basic-auth exchange — via the
        // `confidential()`-when-configured path rather than the placeholder.
        let mut configured = n.clone();
        configured.client_secret = "secret-placeholder";
        assert!(configured.confidential());
    }

    #[test]
    fn registry_ids_unique() {
        let mut ids: Vec<&str> = CONNECTORS.iter().map(|c| c.id).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate connector id in CONNECTORS");
    }

    #[test]
    fn gmail_is_registered() {
        let g = connector_by_id("gmail").expect("gmail registered");
        assert_eq!(g.mcp_server_url, "https://gmailmcp.googleapis.com/mcp/v1");
        assert!(g.registration_url.is_none()); // Google: no DCR, no metadata docs
        assert!(g.revoke_url.is_none());
        assert!(!g.scopes.is_empty()); // URL scope strings (readonly + compose)
        assert_eq!(g.authorize_url, "https://accounts.google.com/o/oauth2/v2/auth");
        assert_eq!(g.token_url, "https://oauth2.googleapis.com/token");
        // Fixed loopback port must be parseable for the callback server and
        // differ from Notion's (independent flows must not collide).
        assert_ne!(
            crate::connectors::oauth::loopback_callback_port(g.redirect_uri),
            Some(NOTION_CALLBACK_PORT)
        );
        assert_eq!(
            crate::connectors::oauth::loopback_callback_port(g.redirect_uri),
            Some(GMAIL_CALLBACK_PORT)
        );
        assert!(g.is_google());
        assert_eq!(g.family, "google"); // Gmail renders under the Google family card
    }

    #[test]
    fn google_workspace_connectors_are_registered() {
        for id in ["gdrive", "gdocs", "gsheets", "gslides", "gcalendar", "gchat", "gpeople"] {
            let c = connector_by_id(id).unwrap_or_else(|| panic!("{id} registered"));
            assert!(c.is_google(), "{id} must share Google's OAuth endpoints");
            assert_eq!(c.family, "google", "{id} must render under the Google family card");
            assert_eq!(c.authorize_url, "https://accounts.google.com/o/oauth2/v2/auth");
            assert_eq!(c.token_url, "https://oauth2.googleapis.com/token");
            assert!(c.registration_url.is_none(), "{id}: Google has no DCR");
            assert!(c.revoke_url.is_none(), "{id}");
            assert!(!c.scopes.is_empty(), "{id}: URL scope strings required");
            // Every Google MCP endpoint is versioned at /mcp/v1.
            assert!(
                c.mcp_server_url.ends_with(".googleapis.com/mcp/v1"),
                "{}: unexpected server URL {}",
                id,
                c.mcp_server_url
            );
            let port = crate::connectors::oauth::loopback_callback_port(c.redirect_uri)
                .unwrap_or_else(|| panic!("{id}: fixed loopback port required"));
            assert_ne!(port, 0, "{id}");
        }
    }

    #[test]
    fn all_connector_callback_ports_unique_and_parseable() {
        let mut ports: Vec<u16> = CONNECTORS
            .iter()
            .filter(|c| !c.is_public())
            .map(|c| {
                crate::connectors::oauth::loopback_callback_port(c.redirect_uri)
                    .unwrap_or_else(|| panic!("{}: fixed loopback port required", c.id))
            })
            .collect();
        ports.sort();
        let n = ports.len();
        ports.dedup();
        assert_eq!(ports.len(), n, "callback ports must not collide across connectors");
    }

    #[test]
    fn kiwi_is_registered_as_public_connector() {
        let k = connector_by_id("kiwi").expect("kiwi registered");
        // Public endpoint: no OAuth, no key, always configured.
        assert!(k.is_public());
        assert!(!k.is_google());
        assert!(k.authorize_url.is_empty());
        assert!(k.token_url.is_empty());
        assert!(k.client_secret.is_empty());
        assert!(k.redirect_uri.is_empty());
        assert_eq!(k.mcp_server_url, "https://mcp.kiwi.com");
        assert_eq!(k.effective_mcp_server_url(), "https://mcp.kiwi.com");
        assert!(k.configured(), "public connector is always usable");
        // The Connect button explains there is nothing to configure.
        assert!(
            crate::connectors::config::no_oauth_flow_reason(k).contains("public"),
            "reason should mention the public endpoint"
        );
        // merge must be fully gone from the registry.
        assert!(connector_by_id("merge").is_none(), "merge was removed");
    }

    #[test]
    fn github_is_registered_as_env_configured_oauth_connector() {
        let g = connector_by_id("github").expect("github registered");
        assert!(!g.is_public(), "github has a real OAuth flow");
        assert!(!g.is_google());
        // Classic GitHub OAuth App endpoints (the RFC 9728 resource metadata
        // names github.com/login/oauth as the authorization server).
        assert_eq!(g.authorize_url, "https://github.com/login/oauth/authorize");
        assert_eq!(g.token_url, "https://github.com/login/oauth/access_token");
        assert_eq!(g.mcp_server_url, "https://api.githubcopilot.com/mcp/");
        // GitHub has no DCR and no public revoke endpoint.
        assert!(g.registration_url.is_none());
        assert!(g.revoke_url.is_none());
        assert_eq!(g.family, "github");
        assert!(!g.scopes.is_empty(), "scope set gates the exposed tool surface");
        // Static env-configured client: `configured()` mirrors client_id
        // presence (empty in plain test builds → Connect errors helpfully).
        assert_eq!(g.configured(), !g.client_id.is_empty());
        let mut configured = g.clone();
        configured.client_id = "Iv1.deadbeef";
        configured.client_secret = "secret-placeholder";
        assert!(configured.confidential());
        assert!(configured.configured());
        let mut unconfigured = g.clone();
        unconfigured.client_id = "";
        unconfigured.client_secret = "";
        assert!(!unconfigured.configured());
        let port = crate::connectors::oauth::loopback_callback_port(g.redirect_uri)
            .expect("fixed loopback port required");
        assert_eq!(port, GITHUB_CALLBACK_PORT);
    }

    #[test]
    fn canva_connector_is_kept_but_disabled_from_ui() {
        // Canva is gated behind its waitlist (redirect-URI allowlisting —
        // `/register` rejects every body until approved, verified live), so it
        // must NOT appear in the Settings UI via CONNECTORS. The const stays
        // with correct endpoints so re-enabling is a one-line change.
        assert!(connector_by_id("canva").is_none(), "canva must be absent from CONNECTORS");
        assert!(
            !CONNECTORS.iter().any(|c| c.id == "canva"),
            "canva must not render in the Settings list"
        );
        let c = super::CANVA;
        assert!(!c.is_public());
        assert!(!c.is_google());
        assert_eq!(c.authorize_url, "https://mcp.canva.com/authorize");
        assert_eq!(c.token_url, "https://mcp.canva.com/token");
        assert_eq!(c.mcp_server_url, "https://mcp.canva.com/mcp");
        assert_eq!(c.revoke_url, Some("https://mcp.canva.com/token"));
        assert_eq!(c.registration_url, Some("https://mcp.canva.com/register"));
        assert_eq!(c.family, "canva");
        assert!(c.configured(), "DCR connector needs no static credentials");
        let port = crate::connectors::oauth::loopback_callback_port(c.redirect_uri)
            .expect("fixed loopback port required");
        assert_eq!(port, CANVA_CALLBACK_PORT);
    }

    #[test]
    fn google_family_members_are_connectable_as_one() {
        let members = family_members("google").expect("google family exists");
        assert!(members.len() > 1, "a family exists to group connect");
        for m in members {
            assert!(m.is_google(), "{} must share Google's OAuth endpoints", m.id);
            assert_eq!(m.family, "google", "{} must belong to the google family", m.id);
        }
        // Every member appears in the registry (the Settings list renders
        // per-member status rows under the family card).
        for m in members {
            assert!(
                CONNECTORS.iter().any(|c| c.id == m.id),
                "{} must stay in CONNECTORS",
                m.id
            );
        }
        // The family flow has its own callback URI/port, distinct from members'.
        let uri = family_redirect_uri("google").expect("family redirect uri");
        let port = crate::connectors::oauth::loopback_callback_port(uri)
            .expect("family uri must be a fixed loopback port");
        assert_eq!(port, GOOGLE_FAMILY_CALLBACK_PORT);
        for m in members {
            let mp = crate::connectors::oauth::loopback_callback_port(m.redirect_uri)
                .expect("member fixed port");
            assert_ne!(mp, port, "{} must not collide with the family port", m.id);
        }
        // Unknown families are rejected so the command layer can error cleanly.
        assert!(family_members("nope").is_none());
        assert!(family_redirect_uri("nope").is_none());
    }
}
