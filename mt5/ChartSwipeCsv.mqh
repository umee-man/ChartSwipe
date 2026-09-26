//+------------------------------------------------------------------+
//|                                               ChartSwipeCsv.mqh  |
//|  Pure helpers for ChartSwipeSync.mq5 (architecture.md §7, §8).   |
//|                                                                  |
//|  No chart objects, no network, no globals: everything here is    |
//|  deterministic so mt5/tests/ChartSwipeCsvTest.mq5 can cover it.  |
//+------------------------------------------------------------------+
#ifndef CHARTSWIPE_CSV_MQH
#define CHARTSWIPE_CSV_MQH

//--- protocol / timing constants
#define CS_POLL_SECONDS       5     // §8: EventSetTimer(5). 12 req/min per chart; limit is 30/min per key (§7)
#define CS_CURSOR_OVERLAP_S   5     // re-read window below the cursor (same-second edits, late commits)
#define CS_BACKOFF_MAX_S      60    // cap for exponential backoff after failures
#define CS_RETRY_AFTER_MAX_S  300   // never trust a Retry-After longer than this
#define CS_CURSOR_MAX_DIGITS  18    // fits into long without overflow

// Default colors in MQL5 BGR form (0x00BBGGRR), used only if the CSV color is empty/invalid.
#define CS_CLR_SUPPORT    ((color)0x327D2E)   // #2E7D32
#define CS_CLR_RESISTANCE ((color)0x2828C6)   // #C62828
#define CS_CLR_ZONE       ((color)0xC06515)   // #1565C0

enum ENUM_CS_ROW_ACTION
  {
   CS_ROW_UPSERT  = 0,   // draw or update in place
   CS_ROW_DELETE  = 1,   // deleted=1 -> ObjectDelete by name
   CS_ROW_INVALID = 2    // malformed row, skipped (see reason)
  };

struct CsRow
  {
   string            id;
   string            symbol;
   string            kind;       // lower-case: support | resistance | zone
   double            price;
   double            priceTo;    // zone only, 0 otherwise
   long              colorRaw;   // BGR value from CSV, -1 if empty/invalid
   ENUM_CS_ROW_ACTION action;
   string            reason;     // why the row is invalid (Russian, for the Experts log)
  };

//+------------------------------------------------------------------+
//| String helpers                                                   |
//+------------------------------------------------------------------+
string CsTrim(string s)
  {
   StringTrimLeft(s);    // removes spaces, tabs, CR and LF
   StringTrimRight(s);
   return s;
  }

string CsField(const string &cols[], const int idx)
  {
   if(idx < 0 || idx >= ArraySize(cols))
      return "";
   return CsTrim(cols[idx]);
  }

int CsColumnIndex(const string &header[], const string name)
  {
   for(int i = 0; i < ArraySize(header); i++)
      if(StringCompare(CsTrim(header[i]), name, false) == 0)
         return i;
   return -1;
  }

bool CsStartsWith(const string s, const string prefix)
  {
   return StringLen(s) >= StringLen(prefix) && StringSubstr(s, 0, StringLen(prefix)) == prefix;
  }

//+------------------------------------------------------------------+
//| Colors (A7: CSV already carries BGR 0x00BBGGRR, 6 hex digits)    |
//+------------------------------------------------------------------+
//--- Parses "0x327D2E" / "327D2E". Returns -1 on invalid input or more than 6 hex digits,
//--- so values like 0xFFFFFFFF (== clrNONE, invisible) can never reach the chart.
long CsParseHex(string s)
  {
   s = CsTrim(s);
   if(CsStartsWith(s, "0x") || CsStartsWith(s, "0X"))
      s = StringSubstr(s, 2);
   int n = StringLen(s);
   if(n == 0 || n > 6)
      return -1;
   long v = 0;
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      int d;
      if(c >= '0' && c <= '9')
         d = c - '0';
      else if(c >= 'a' && c <= 'f')
         d = c - 'a' + 10;
      else if(c >= 'A' && c <= 'F')
         d = c - 'A' + 10;
      else
         return -1;
      v = v * 16 + d;
     }
   return v;
  }

color CsKindDefaultColor(const string kind)
  {
   if(kind == "resistance")
      return CS_CLR_RESISTANCE;
   if(kind == "zone")
      return CS_CLR_ZONE;
   return CS_CLR_SUPPORT;
  }

color CsResolveColor(const long raw, const string kind)
  {
   if(raw >= 0 && raw <= 0xFFFFFF)
      return (color)raw;
   return CsKindDefaultColor(kind);
  }

//+------------------------------------------------------------------+
//| Cursor rules (A6)                                                |
//+------------------------------------------------------------------+
//--- Accepts only a non-empty string of ASCII digits (no sign, no exponent, no dot).
bool CsParseCursor(const string s, long &out)
  {
   out = -1;
   int n = StringLen(s);
   if(n == 0 || n > CS_CURSOR_MAX_DIGITS)
      return false;
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c < '0' || c > '9')
         return false;
     }
   out = StringToInteger(s);
   return out >= 0;
  }

//--- since for the next request. The overlap re-reads the last few seconds: two edits within
//--- one second, or a row whose transaction started before the cursor but committed after the
//--- poll, would otherwise be lost. Every row is an idempotent upsert/delete, so it is harmless.
long CsSinceFor(const bool full, const long cursor)
  {
   if(full || cursor <= 0)
      return 0;
   return MathMax(0, cursor - CS_CURSOR_OVERLAP_S);
  }

//--- The cursor only moves after the whole batch was applied; incremental syncs never move it back.
bool CsShouldSaveCursor(const bool full, const long newCursor, const long oldCursor)
  {
   if(newCursor < 0)
      return false;
   return full || newCursor >= oldCursor;
  }

//+------------------------------------------------------------------+
//| Backoff after failures (429 / 5xx / network)                     |
//+------------------------------------------------------------------+
//--- failStreak 1 -> 10 s, 2 -> 20 s, 3 -> 40 s, 4+ -> 60 s. Retry-After (if any) wins when longer.
int CsBackoffSeconds(const int failStreak, const int retryAfter)
  {
   if(failStreak <= 0)
      return 0;
   int shift = MathMin(failStreak, 4);
   int delay = MathMin(CS_BACKOFF_MAX_S, CS_POLL_SECONDS * (1 << shift));
   if(retryAfter > 0)
      delay = MathMax(delay, MathMin(retryAfter, CS_RETRY_AFTER_MAX_S));
   return delay;
  }

//--- Reads "Retry-After: <seconds>" from WebRequest response headers. HTTP-date form is ignored.
int CsParseRetryAfter(const string headers)
  {
   string lines[];
   int n = StringSplit(headers, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      string line = CsTrim(lines[i]);
      int colon = StringFind(line, ":");
      if(colon <= 0)
         continue;
      if(StringCompare(CsTrim(StringSubstr(line, 0, colon)), "Retry-After", false) != 0)
         continue;
      long v;
      if(CsParseCursor(CsTrim(StringSubstr(line, colon + 1)), v) && v <= 86400)
         return (int)v;
      return -1;
     }
   return -1;
  }

//+------------------------------------------------------------------+
//| Input validation                                                 |
//+------------------------------------------------------------------+
//--- Local dev escape: plain http only for localhost / 127.0.0.1 (host must end right there).
bool CsIsLocalHttp(const string lower)
  {
   string hosts[2] = {"http://localhost", "http://127.0.0.1"};
   for(int i = 0; i < 2; i++)
     {
      if(!CsStartsWith(lower, hosts[i]))
         continue;
      if(StringLen(lower) == StringLen(hosts[i]))
         return true;
      ushort next = StringGetCharacter(lower, StringLen(hosts[i]));
      if(next == ':' || next == '/')
         return true;
     }
   return false;
  }

//--- §11: HTTPS is mandatory (the API key travels in a header). Strips trailing slashes.
bool CsNormalizeApiUrl(const string raw, string &url, string &err)
  {
   url = CsTrim(raw);
   while(StringLen(url) > 0 && StringGetCharacter(url, StringLen(url) - 1) == '/')
      url = StringSubstr(url, 0, StringLen(url) - 1);
   err = "";
   if(url == "")
     {
      err = "Не задан ApiUrl, например https://api.example.com";
      return false;
     }
   string lower = url;
   StringToLower(lower);
   if(CsStartsWith(lower, "https://") && StringLen(lower) > 8)
      return true;
   if(CsIsLocalHttp(lower))
      return true;
   err = "ApiUrl должен начинаться с https://";
   return false;
  }

//--- Trims whitespace/newlines pasted with the key and rejects control characters inside it
//--- (a CR/LF in the middle would inject extra HTTP headers).
bool CsNormalizeApiKey(const string raw, string &key, string &err)
  {
   key = CsTrim(raw);
   err = "";
   if(key == "")
     {
      err = "Не задан ApiKey (создаётся в приложении, раздел «Интеграции»)";
      return false;
     }
   for(int i = 0; i < StringLen(key); i++)
     {
      ushort c = StringGetCharacter(key, i);
      if(c < 0x20 || c == 0x7F)
        {
         err = "ApiKey содержит недопустимые символы (перевод строки или управляющий символ)";
         key = "";
         return false;
        }
     }
   return true;
  }

//+------------------------------------------------------------------+
//| Symbol matching (§8: level symbol + broker suffix == chart)      |
//+------------------------------------------------------------------+
bool CsSymbolMatches(const string levelSymbol, const string suffix, const string chartSymbol,
                     const bool showAll)
  {
   if(showAll)
      return true;
   return StringCompare(levelSymbol + suffix, chartSymbol, false) == 0;
  }

//+------------------------------------------------------------------+
//| CSV parsing (contract: architecture.md §7)                       |
//|   #cursor,<unix_ts>                                              |
//|   id,symbol,kind,price,price_to,color,deleted,updated_at         |
//|   <rows...>                                                      |
//| Returns false (cursor must not move) if the format is not        |
//| recognized. Rows with an empty id are dropped silently.          |
//+------------------------------------------------------------------+
bool CsParseSyncCsv(string body, long &cursor, CsRow &rows[], string &err)
  {
   cursor = -1;
   err = "";
   ArrayResize(rows, 0);

   // Strip UTF-8 BOM and normalize CRLF / CR to LF.
   if(StringLen(body) > 0 && StringGetCharacter(body, 0) == 0xFEFF)
      body = StringSubstr(body, 1);
   StringReplace(body, "\r\n", "\n");
   StringReplace(body, "\r", "\n");

   string lines[];
   int nLines = StringSplit(body, '\n', lines);
   int li = 0;
   while(li < nLines && CsTrim(lines[li]) == "")
      li++;
   if(li >= nLines)
     {
      err = "пустой ответ сервера";
      return false;
     }

   // "#cursor,<ts>"
   string cur[];
   StringSplit(CsTrim(lines[li]), ',', cur);
   if(ArraySize(cur) < 1 || CsTrim(cur[0]) != "#cursor")
     {
      err = "в ответе нет строки #cursor — формат не распознан";
      return false;
     }
   long parsed;
   if(ArraySize(cur) != 2 || !CsParseCursor(CsField(cur, 1), parsed))
     {
      err = "некорректное значение #cursor: " + CsTrim(lines[li]);
      return false;
     }
   li++;

   // Header line: map columns by name so order changes don't break parsing.
   while(li < nLines && CsTrim(lines[li]) == "")
      li++;
   if(li >= nLines)
     {
      cursor = parsed;   // cursor only, no rows and no header: nothing changed
      return true;
     }

   string header[];
   StringSplit(CsTrim(lines[li]), ',', header);
   int cId = CsColumnIndex(header, "id");
   int cSym = CsColumnIndex(header, "symbol");
   int cKind = CsColumnIndex(header, "kind");
   int cPrice = CsColumnIndex(header, "price");
   int cPriceTo = CsColumnIndex(header, "price_to");
   int cColor = CsColumnIndex(header, "color");
   int cDel = CsColumnIndex(header, "deleted");
   if(cId < 0 || cSym < 0 || cKind < 0 || cPrice < 0 || cDel < 0)
     {
      err = "заголовок CSV не распознан: " + CsTrim(lines[li]);
      return false;
     }
   li++;

   for(; li < nLines; li++)
     {
      string line = CsTrim(lines[li]);
      if(line == "" || StringGetCharacter(line, 0) == '#')
         continue;

      string cols[];
      StringSplit(line, ',', cols);

      CsRow r;
      r.id = CsField(cols, cId);
      if(r.id == "")
         continue;
      r.symbol = CsField(cols, cSym);
      r.kind = CsField(cols, cKind);
      StringToLower(r.kind);
      r.price = 0;
      r.priceTo = 0;
      r.colorRaw = CsParseHex(CsField(cols, cColor));
      r.reason = "";
      r.action = CS_ROW_UPSERT;

      if(CsField(cols, cDel) == "1")
         r.action = CS_ROW_DELETE;
      else
        {
         r.price = StringToDouble(CsField(cols, cPrice));
         if(r.kind != "support" && r.kind != "resistance" && r.kind != "zone")
           {
            r.action = CS_ROW_INVALID;
            r.reason = "неизвестный тип уровня '" + r.kind + "'";
           }
         else if(r.price <= 0)
           {
            r.action = CS_ROW_INVALID;
            r.reason = "некорректная цена";
           }
         else if(r.kind == "zone")
           {
            string pt = CsField(cols, cPriceTo);
            r.priceTo = (pt == "") ? 0 : StringToDouble(pt);
            if(pt == "")
              {
               r.action = CS_ROW_INVALID;
               r.reason = "у зоны нет price_to";
              }
            else if(r.priceTo <= 0)
              {
               r.action = CS_ROW_INVALID;
               r.reason = "некорректный price_to у зоны";
              }
           }
        }

      int n = ArraySize(rows);
      ArrayResize(rows, n + 1);
      rows[n] = r;
     }

   cursor = parsed;
   return true;
  }

#endif // CHARTSWIPE_CSV_MQH
