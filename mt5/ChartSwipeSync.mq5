//+------------------------------------------------------------------+
//|                                              ChartSwipeSync.mq5  |
//|  ChartSwipe -> MetaTrader 5 level sync (architecture.md §7, §8)  |
//|                                                                  |
//|  Polls GET {ApiUrl}/v1/sync/mt5?since=<cursor> with X-API-Key,   |
//|  parses the CSV and draws levels as chart objects named          |
//|  CS_<level_id>. This EA contains NO trading functions at all     |
//|  (prop-firm requirement): no CTrade, no OrderSend, no positions. |
//|                                                                  |
//|  Pure parsing/cursor/backoff logic lives in ChartSwipeCsv.mqh    |
//|  (same folder) and is covered by tests/ChartSwipeCsvTest.mq5.    |
//+------------------------------------------------------------------+
#property copyright "ChartSwipe"
#property version   "1.10"
#property description "ChartSwipe: синхронизация уровней из приложения на график MT5."
#property description "Не торгует: советник только рисует линии и зоны."

#include "ChartSwipeCsv.mqh"

//--- inputs (exactly the §8 contract; poll period is fixed at CS_POLL_SECONDS)
input string ApiUrl         = "https://api.example.com"; // Адрес API ChartSwipe (без /v1), только https://
input string ApiKey         = "";                        // API-ключ из приложения (Интеграции)
input string SymbolSuffix   = "";                        // Суффикс брокера: .r, m, -P ...
input bool   ShowAllSymbols = false;                     // Рисовать уровни всех символов на этом графике

//--- constants
#define CS_PREFIX          "CS_"
#define CS_HTTP_TIMEOUT_MS 5000
#define CS_ERR_URL_BLOCKED 4014   // ERR_FUNCTION_NOT_ALLOWED: URL not in WebRequest allow-list

//--- far-past / far-future anchors for zone rectangles (effectively infinite in time)
const datetime CS_TIME_FAR_PAST   = D'1971.01.01 00:00';
const datetime CS_TIME_FAR_FUTURE = D'2099.12.31 00:00';

//--- state
string   g_baseUrl        = "";
string   g_apiKey         = "";     // trimmed and validated copy of ApiKey
string   g_gvName         = "";     // GlobalVariable holding the cursor (source hash + chart id)
long     g_cursor         = 0;      // last server cursor (unix seconds)
bool     g_forceFull      = true;   // next request uses since=0 and prunes stale objects
bool     g_urlWarned      = false;  // allow-list hint already printed
int      g_failStreak     = 0;      // consecutive failed requests (for backoff)
ulong    g_backoffUntilMs = 0;      // GetTickCount64() deadline; no requests before it
int      g_lastCount      = 0;
datetime g_lastOkTime     = 0;

string KindTitle(const string kind)
  {
   if(kind == "support")
      return "поддержка";
   if(kind == "resistance")
      return "сопротивление";
   if(kind == "zone")
      return "зона";
   return kind;
  }

//+------------------------------------------------------------------+
//| Cursor persistence (§8: GlobalVariable of the terminal)          |
//+------------------------------------------------------------------+
//--- Key = short hash of the data source (ApiUrl, ApiKey, SymbolSuffix, chart symbol, mode)
//--- + ChartID(), so two charts, another server/user or another suffix never share a cursor.
string BuildGvName()
  {
   string src = g_baseUrl + "|" + g_apiKey + "|" + SymbolSuffix + "|" + ChartSymbol(0) + "|" +
                (ShowAllSymbols ? "A" : "S");
   uchar data[], key[], hash[];
   StringToCharArray(src, data, 0, WHOLE_ARRAY, CP_UTF8);
   string h = "";
   if(CryptEncode(CRYPT_HASH_SHA256, data, key, hash) >= 4)
      for(int i = 0; i < 4; i++)
         h += StringFormat("%02x", hash[i]);
   else
      h = "nohash";
   return "CS_cur_" + h + "_" + IntegerToString(ChartID());   // < 63 chars
  }

void SaveCursor(const long cursor)
  {
   g_cursor = cursor;
   if(g_gvName != "")
     {
      GlobalVariableSet(g_gvName, (double)cursor);
      GlobalVariablesFlush();
     }
  }

//+------------------------------------------------------------------+
//| Chart objects                                                    |
//+------------------------------------------------------------------+
int CountOwnObjects()
  {
   int cnt = 0;
   int total = ObjectsTotal(0, -1, -1);
   for(int i = 0; i < total; i++)
      if(StringFind(ObjectName(0, i, -1, -1), CS_PREFIX) == 0)
         cnt++;
   return cnt;
  }

void ApplyCommonProps(const string name, const color clr, const string tip)
  {
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_SOLID);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);   // edits happen in the app, not here
   ObjectSetInteger(0, name, OBJPROP_SELECTED, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, false);
   ObjectSetString(0, name, OBJPROP_TEXT, tip);
   ObjectSetString(0, name, OBJPROP_TOOLTIP, tip);
  }

//--- Creates or updates in place (idempotent). Recreates if the object type changed (support -> zone).
bool DrawLevel(const string name, const string kind, const double price, const double priceTo,
               const color clr, const string symbol)
  {
   ENUM_OBJECT want = (kind == "zone") ? OBJ_RECTANGLE : OBJ_HLINE;

   if(ObjectFind(0, name) >= 0 && (ENUM_OBJECT)ObjectGetInteger(0, name, OBJPROP_TYPE) != want)
      ObjectDelete(0, name);

   string tip = "ChartSwipe " + symbol + ": " + KindTitle(kind) + " " + DoubleToString(price, _Digits);
   if(want == OBJ_RECTANGLE)
      tip += " - " + DoubleToString(priceTo, _Digits);

   if(ObjectFind(0, name) < 0)
     {
      bool ok = (want == OBJ_HLINE)
                ? ObjectCreate(0, name, OBJ_HLINE, 0, 0, price)
                : ObjectCreate(0, name, OBJ_RECTANGLE, 0, CS_TIME_FAR_PAST, price, CS_TIME_FAR_FUTURE, priceTo);
      if(!ok)
        {
         PrintFormat("ChartSwipe: не удалось создать объект %s, ошибка %d", name, GetLastError());
         return false;
        }
     }
   else
     {
      if(want == OBJ_HLINE)
         ObjectSetDouble(0, name, OBJPROP_PRICE, 0, price);
      else
        {
         ObjectMove(0, name, 0, CS_TIME_FAR_PAST, price);
         ObjectMove(0, name, 1, CS_TIME_FAR_FUTURE, priceTo);
        }
     }

   ApplyCommonProps(name, clr, tip);
   if(want == OBJ_RECTANGLE)
     {
      ObjectSetInteger(0, name, OBJPROP_FILL, true);
      ObjectSetInteger(0, name, OBJPROP_BACK, true);
     }
   else
      ObjectSetInteger(0, name, OBJPROP_BACK, false);
   return true;
  }

void DeleteIfExists(const string name)
  {
   if(ObjectFind(0, name) >= 0)
      ObjectDelete(0, name);
  }

//--- After a full snapshot (since=0): remove our objects that are no longer in it.
//--- keepList is "|name1|name2|...|". Objects without the CS_ prefix are never touched.
int PruneStale(const string keepList)
  {
   int removed = 0;
   for(int i = ObjectsTotal(0, -1, -1) - 1; i >= 0; i--)
     {
      string name = ObjectName(0, i, -1, -1);
      if(StringFind(name, CS_PREFIX) != 0)
         continue;
      if(StringFind(keepList, "|" + name + "|") >= 0)
         continue;
      if(ObjectDelete(0, name))
         removed++;
     }
   return removed;
  }

//--- Applies parsed rows to this chart. Returns the number of rows that changed/confirmed objects.
int ApplyRows(const CsRow &rows[], const bool fullSnapshot)
  {
   int applied = 0;
   string keep = "|";
   for(int i = 0; i < ArraySize(rows); i++)
     {
      string name = CS_PREFIX + rows[i].id;
      if(rows[i].action == CS_ROW_DELETE)
        {
         DeleteIfExists(name);
         applied++;
         continue;
        }
      if(rows[i].action == CS_ROW_INVALID)
        {
         Print("ChartSwipe: уровень ", rows[i].id, " пропущен: ", rows[i].reason);
         continue;
        }
      // Level belongs to another symbol (or was moved away): make sure it is not on this chart.
      if(!CsSymbolMatches(rows[i].symbol, SymbolSuffix, ChartSymbol(0), ShowAllSymbols))
        {
         DeleteIfExists(name);
         continue;
        }
      color clr = CsResolveColor(rows[i].colorRaw, rows[i].kind);   // already BGR (A7)
      if(DrawLevel(name, rows[i].kind, rows[i].price, rows[i].priceTo, clr, rows[i].symbol))
        {
         applied++;
         keep += name + "|";
        }
     }

   if(fullSnapshot)
     {
      int removed = PruneStale(keep);
      if(removed > 0)
         PrintFormat("ChartSwipe: удалено устаревших объектов: %d", removed);
     }
   return applied;
  }

//+------------------------------------------------------------------+
//| Status output                                                    |
//+------------------------------------------------------------------+
void ShowStatus(const string line)
  {
   Comment("ChartSwipe Sync\n", line);
  }

void ShowUrlNotAllowed()
  {
   string msg =
      "WebRequest запрещён для адреса " + g_baseUrl + ".\n"
      "Откройте Сервис -> Настройки -> Советники,\n"
      "включите «Разрешить WebRequest для следующих URL»\n"
      "и добавьте: " + g_baseUrl + "\n"
      "После этого советник подхватит изменения сам.";
   ShowStatus(msg);
   if(!g_urlWarned)
     {
      Print("ChartSwipe: ошибка 4014 — URL не в списке разрешённых. Сервис -> Настройки -> Советники -> "
            "«Разрешить WebRequest для следующих URL» -> добавьте ", g_baseUrl);
      g_urlWarned = true;
     }
  }

//--- Registers a failed request and schedules the next attempt with exponential backoff.
int RegisterFailure(const int retryAfter)
  {
   g_failStreak++;
   int delay = CsBackoffSeconds(g_failStreak, retryAfter);
   g_backoffUntilMs = GetTickCount64() + (ulong)delay * 1000;
   return delay;
  }

//+------------------------------------------------------------------+
//| One sync cycle                                                   |
//+------------------------------------------------------------------+
void SyncOnce()
  {
   if(MQLInfoInteger(MQL_TESTER))
      return;   // WebRequest is unavailable in the Strategy Tester
   if(g_backoffUntilMs > 0 && GetTickCount64() < g_backoffUntilMs)
      return;   // backing off after 429 / 5xx / network error

   bool full = g_forceFull || g_cursor <= 0;
   long since = CsSinceFor(full, g_cursor);
   string url = g_baseUrl + "/v1/sync/mt5?since=" + IntegerToString(since);
   string headers = "X-API-Key: " + g_apiKey + "\r\nAccept: text/csv\r\n";

   char data[];
   char result[];
   string resultHeaders = "";
   ArrayResize(data, 0);

   ResetLastError();
   int status = WebRequest("GET", url, headers, CS_HTTP_TIMEOUT_MS, data, result, resultHeaders);

   if(status == -1)
     {
      int err = GetLastError();
      if(err == CS_ERR_URL_BLOCKED)
        {
         ShowUrlNotAllowed();   // no network traffic happened: keep checking every tick
         return;
        }
      int delay = RegisterFailure(-1);
      PrintFormat("ChartSwipe: WebRequest не выполнен, ошибка %d", err);
      ShowStatus("Нет связи с сервером (ошибка " + IntegerToString(err) + "). Повтор через " +
                 IntegerToString(delay) + " с.");
      return;
     }
   g_urlWarned = false;

   if(status != 200)
     {
      string hint;
      if(status == 401 || status == 403)
         hint = "API-ключ неверный или отозван. Создайте новый в приложении (Интеграции).";
      else if(status == 429)
         hint = "Слишком частые запросы (лимит 30/мин на ключ). Не запускайте советник "
                "больше чем на 2 графиках с одним ключом.";
      else if(status >= 500)
         hint = "Ошибка сервера.";
      else
         hint = "Неожиданный ответ сервера.";
      int delay = RegisterFailure(CsParseRetryAfter(resultHeaders));
      PrintFormat("ChartSwipe: HTTP %d — %s Повтор через %d с.", status, hint, delay);
      ShowStatus("HTTP " + IntegerToString(status) + ": " + hint + "\nПовтор через " +
                 IntegerToString(delay) + " с.");
      return;
     }
   g_failStreak = 0;
   g_backoffUntilMs = 0;

   string body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   long newCursor = -1;
   CsRow rows[];
   string perr = "";
   if(!CsParseSyncCsv(body, newCursor, rows, perr))
     {
      Print("ChartSwipe: ", perr);
      ShowStatus("Ответ сервера не распознан, курсор не сдвинут. См. вкладку «Эксперты».");
      return;
     }
   int applied = ApplyRows(rows, full);

   // Only move the cursor after the whole batch was applied (A6: server clock).
   if(CsShouldSaveCursor(full, newCursor, g_cursor))
      SaveCursor(newCursor);
   g_forceFull = false;

   if(applied > 0)
      ChartRedraw(0);

   g_lastCount = applied;
   g_lastOkTime = TimeLocal();
   ShowStatus("Синхронизировано: " + TimeToString(g_lastOkTime, TIME_DATE | TIME_SECONDS) +
              (applied > 0 ? "  (обработано строк: " + IntegerToString(applied) + ")" : "") +
              "\nСимвол: " + (ShowAllSymbols ? "все" : ChartSymbol(0)) +
              "   Уровней на графике: " + IntegerToString(CountOwnObjects()));
  }

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   string err = "";
   if(!CsNormalizeApiUrl(ApiUrl, g_baseUrl, err))
     {
      Print("ChartSwipe: ", err);
      ShowStatus(err);
      return INIT_PARAMETERS_INCORRECT;
     }
   if(!CsNormalizeApiKey(ApiKey, g_apiKey, err))
     {
      Print("ChartSwipe: ", err);
      ShowStatus(err);
      return INIT_PARAMETERS_INCORRECT;
     }

   // Every start takes a full snapshot (one since=0 request). The stored cursor could belong to
   // another chart, server, user or suffix, and PruneStale makes a snapshot self-correcting.
   // The cursor is still written to the GlobalVariable after each successful sync (§8).
   g_gvName = BuildGvName();
   g_cursor = 0;
   g_forceFull = true;
   g_failStreak = 0;
   g_backoffUntilMs = 0;
   g_urlWarned = false;

   if(!EventSetTimer(CS_POLL_SECONDS))
     {
      PrintFormat("ChartSwipe: не удалось запустить таймер, ошибка %d", GetLastError());
      return INIT_FAILED;
     }

   ShowStatus("Запуск... опрос каждые " + IntegerToString(CS_POLL_SECONDS) + " с.");
   SyncOnce();
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
//| Expert deinitialization: stop timer, keep drawn objects          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

//+------------------------------------------------------------------+
//| Timer                                                            |
//+------------------------------------------------------------------+
void OnTimer()
  {
   SyncOnce();
  }

//+------------------------------------------------------------------+
//| No OnTick trading logic: the EA never trades.                    |
//+------------------------------------------------------------------+
void OnTick()
  {
  }
//+------------------------------------------------------------------+
