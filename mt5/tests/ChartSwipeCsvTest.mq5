//+------------------------------------------------------------------+
//|                                           ChartSwipeCsvTest.mq5  |
//|  Offline tests for the pure helpers in ../ChartSwipeCsv.mqh.     |
//|  Run as a Script on any chart (demo terminal is enough): every   |
//|  check prints PASS/FAIL, the last line is the summary. No        |
//|  network, no chart objects, no trading.                          |
//+------------------------------------------------------------------+
#property copyright "ChartSwipe"
#property version   "1.00"
#property script_show_inputs false

#include "../ChartSwipeCsv.mqh"

int g_pass = 0;
int g_fail = 0;

void Check(const string name, const bool cond)
  {
   if(cond)
     {
      g_pass++;
      Print("PASS ", name);
     }
   else
     {
      g_fail++;
      Print("FAIL ", name);
     }
  }

const string HDR = "id,symbol,kind,price,price_to,color,deleted,updated_at";

//+------------------------------------------------------------------+
void TestCsvParsing()
  {
   CsRow rows[];
   long cur;
   string err;

   // normal
   string body = "#cursor,1790380740\n" + HDR + "\n9f1c,BTCUSD.r,support,64200,,0x327D2E,0,1790380712\n";
   bool ok = CsParseSyncCsv(body, cur, rows, err);
   Check("normal: parsed", ok);
   Check("normal: cursor", cur == 1790380740);
   Check("normal: one row", ArraySize(rows) == 1);
   if(ArraySize(rows) == 1)
     {
      Check("normal: upsert", rows[0].action == CS_ROW_UPSERT);
      Check("normal: id/symbol/kind", rows[0].id == "9f1c" && rows[0].symbol == "BTCUSD.r" && rows[0].kind == "support");
      Check("normal: price", MathAbs(rows[0].price - 64200) < 1e-9);
      Check("normal: color BGR", rows[0].colorRaw == 0x327D2E);
     }

   // BOM + CRLF
   body = ShortToString(0xFEFF) + "#cursor,1790380740\r\n" + HDR + "\r\n" +
          "a1,ETHUSD,resistance,3120.5,,0x2828C6,0,1790380700\r\n";
   ok = CsParseSyncCsv(body, cur, rows, err);
   Check("bom+crlf: parsed", ok && cur == 1790380740 && ArraySize(rows) == 1);
   if(ArraySize(rows) == 1)
      Check("bom+crlf: values", rows[0].kind == "resistance" && MathAbs(rows[0].price - 3120.5) < 1e-9 &&
            rows[0].colorRaw == 0x2828C6);

   // reordered columns
   body = "#cursor,100\ndeleted,color,price_to,price,kind,symbol,id,updated_at\n"
          "0,0xC06515,63400,63000,zone,BTCUSD,z1,99\n";
   ok = CsParseSyncCsv(body, cur, rows, err);
   Check("reordered: parsed", ok && ArraySize(rows) == 1);
   if(ArraySize(rows) == 1)
      Check("reordered: zone values", rows[0].id == "z1" && rows[0].kind == "zone" &&
            rows[0].action == CS_ROW_UPSERT && MathAbs(rows[0].price - 63000) < 1e-9 &&
            MathAbs(rows[0].priceTo - 63400) < 1e-9);

   // zone without price_to, unknown kind, bad price, empty id, upper-case kind
   body = "#cursor,100\n" + HDR + "\n"
          "z2,BTCUSD,zone,63000,,,0,99\n"
          "k1,BTCUSD,trendline,63000,,,0,99\n"
          "p1,BTCUSD,support,abc,,,0,99\n"
          ",BTCUSD,support,1,,,0,99\n"
          "u1,BTCUSD,SUPPORT,1,,,0,99\n";
   ok = CsParseSyncCsv(body, cur, rows, err);
   Check("invalid rows: parsed, empty id dropped", ok && ArraySize(rows) == 4);
   if(ArraySize(rows) == 4)
     {
      Check("zone without price_to -> invalid", rows[0].action == CS_ROW_INVALID);
      Check("unknown kind -> invalid", rows[1].action == CS_ROW_INVALID);
      Check("non-numeric price -> invalid", rows[2].action == CS_ROW_INVALID);
      Check("kind is lower-cased", rows[3].kind == "support" && rows[3].action == CS_ROW_UPSERT);
     }

   // deleted=1 needs no price
   body = "#cursor,200\n" + HDR + "\nd1,BTCUSD,support,,,,1,199\n";
   ok = CsParseSyncCsv(body, cur, rows, err);
   Check("deleted: parsed", ok && cur == 200 && ArraySize(rows) == 1);
   if(ArraySize(rows) == 1)
      Check("deleted: action", rows[0].action == CS_ROW_DELETE && rows[0].id == "d1");

   // cursor only / blank lines
   ok = CsParseSyncCsv("\n#cursor,300\n\n", cur, rows, err);
   Check("cursor only", ok && cur == 300 && ArraySize(rows) == 0);

   // format errors: cursor must stay untouched (-1 returned)
   ok = CsParseSyncCsv(HDR + "\nx,BTCUSD,support,1,,,0,1\n", cur, rows, err);
   Check("no #cursor line -> error", !ok && cur == -1);
   ok = CsParseSyncCsv("", cur, rows, err);
   Check("empty body -> error", !ok);
   ok = CsParseSyncCsv("#cursor,100\nsymbol,kind,price,deleted\n", cur, rows, err);
   Check("header without id -> error", !ok && cur == -1);

   string bad[] = {"#cursor,abc", "#cursor,1.79e9", "#cursor,-5", "#cursor,", "#cursor", "#cursor,1,2",
                   "#cursor,1790380740x", "#cursor,9999999999999999999"};
   for(int i = 0; i < ArraySize(bad); i++)
     {
      ok = CsParseSyncCsv(bad[i] + "\n" + HDR + "\n", cur, rows, err);
      Check("malformed cursor rejected: " + bad[i], !ok && cur == -1);
     }
  }

//+------------------------------------------------------------------+
void TestColors()
  {
   Check("hex 0x327D2E", CsParseHex("0x327D2E") == 0x327D2E);
   Check("hex 327d2e", CsParseHex("327d2e") == 0x327D2E);
   Check("hex 0xFFFFFFFF rejected", CsParseHex("0xFFFFFFFF") == -1);
   Check("hex 7 digits rejected", CsParseHex("1327D2E") == -1);
   Check("hex bare 0x rejected", CsParseHex("0x") == -1);
   Check("hex garbage rejected", CsParseHex("zz") == -1);
   Check("hex empty rejected", CsParseHex("") == -1);
   Check("resolve invalid -> zone default", CsResolveColor(-1, "zone") == CS_CLR_ZONE);
   Check("resolve invalid -> resistance default", CsResolveColor(-1, "resistance") == CS_CLR_RESISTANCE);
   Check("resolve too big -> default", CsResolveColor(0x1000000, "support") == CS_CLR_SUPPORT);
   Check("resolve valid passthrough", CsResolveColor(0x123456, "support") == (color)0x123456);
  }

//+------------------------------------------------------------------+
void TestCursorRules()
  {
   Check("since full = 0", CsSinceFor(true, 1000) == 0);
   Check("since no cursor = 0", CsSinceFor(false, 0) == 0);
   Check("since overlap", CsSinceFor(false, 1000) == 1000 - CS_CURSOR_OVERLAP_S);
   Check("since overlap clamps at 0", CsSinceFor(false, 3) == 0);
   Check("save: full always", CsShouldSaveCursor(true, 5, 1000));
   Check("save: incremental forward", CsShouldSaveCursor(false, 1001, 1000));
   Check("save: incremental equal", CsShouldSaveCursor(false, 1000, 1000));
   Check("save: never backwards", !CsShouldSaveCursor(false, 995, 1000));
   Check("save: invalid cursor", !CsShouldSaveCursor(true, -1, 0));

   long v;
   Check("parse cursor ok", CsParseCursor("1790380740", v) && v == 1790380740);
   Check("parse cursor zero", CsParseCursor("0", v) && v == 0);
   Check("parse cursor sign rejected", !CsParseCursor("+5", v));
  }

//+------------------------------------------------------------------+
void TestBackoff()
  {
   Check("backoff none", CsBackoffSeconds(0, -1) == 0);
   Check("backoff 1 -> 10", CsBackoffSeconds(1, -1) == 10);
   Check("backoff 2 -> 20", CsBackoffSeconds(2, -1) == 20);
   Check("backoff 3 -> 40", CsBackoffSeconds(3, -1) == 40);
   Check("backoff capped 60", CsBackoffSeconds(10, -1) == 60);
   Check("retry-after wins", CsBackoffSeconds(1, 120) == 120);
   Check("retry-after capped", CsBackoffSeconds(1, 100000) == CS_RETRY_AFTER_MAX_S);
   Check("retry-after shorter ignored", CsBackoffSeconds(3, 2) == 40);

   Check("retry-after header", CsParseRetryAfter("Content-Type: text/csv\r\nretry-after: 17\r\n") == 17);
   Check("retry-after absent", CsParseRetryAfter("Content-Type: text/csv\r\n") == -1);
   Check("retry-after http-date ignored", CsParseRetryAfter("Retry-After: Wed, 21 Oct 2026 07:28:00 GMT\r\n") == -1);
  }

//+------------------------------------------------------------------+
void TestInputs()
  {
   string url, key, err;
   Check("url https + trailing slash", CsNormalizeApiUrl(" https://api.x.com/ ", url, err) && url == "https://api.x.com");
   Check("url HTTPS upper", CsNormalizeApiUrl("HTTPS://api.x.com", url, err));
   Check("url plain http rejected", !CsNormalizeApiUrl("http://api.x.com", url, err));
   Check("url localhost allowed", CsNormalizeApiUrl("http://localhost:8000", url, err));
   Check("url 127.0.0.1 allowed", CsNormalizeApiUrl("http://127.0.0.1/", url, err) && url == "http://127.0.0.1");
   Check("url localhost.evil rejected", !CsNormalizeApiUrl("http://localhost.evil.com", url, err));
   Check("url empty rejected", !CsNormalizeApiUrl("  ", url, err));
   Check("url ftp rejected", !CsNormalizeApiUrl("ftp://x.com", url, err));
   Check("url bare https rejected", !CsNormalizeApiUrl("https://", url, err));

   Check("key trimmed", CsNormalizeApiKey(" cs_abc123 \r\n", key, err) && key == "cs_abc123");
   Check("key header injection rejected", !CsNormalizeApiKey("abc\r\nX-Evil: 1", key, err));
   Check("key tab inside rejected", !CsNormalizeApiKey("ab\tc", key, err));
   Check("key empty rejected", !CsNormalizeApiKey("", key, err));

   Check("symbol + suffix", CsSymbolMatches("BTCUSD", ".r", "BTCUSD.r", false));
   Check("symbol case-insensitive", CsSymbolMatches("btcusd", ".r", "BTCUSD.R", false));
   Check("symbol missing suffix", !CsSymbolMatches("BTCUSD", "", "BTCUSD.r", false));
   Check("symbol other", !CsSymbolMatches("ETHUSD", ".r", "BTCUSD.r", false));
   Check("symbol show all", CsSymbolMatches("ETHUSD", ".r", "BTCUSD.r", true));
  }

//+------------------------------------------------------------------+
void OnStart()
  {
   TestCsvParsing();
   TestColors();
   TestCursorRules();
   TestBackoff();
   TestInputs();
   PrintFormat("ChartSwipeCsvTest: %d passed, %d failed -> %s", g_pass, g_fail, g_fail == 0 ? "OK" : "FAILED");
  }
//+------------------------------------------------------------------+
