/*
 * ==============================================================================
 * NuraSense TPP — ESP32 Cloud ECG Telemetry Firmware
 * Target: ESP32 (DevKit v1 / NodeMCU-32S / ESP32-WROOM-32)
 * Sensor: BioAmp BisCute / AD8232 Single-Lead ECG
 * 
 * Sampling rate: 250 Hz (1 sample every 4,000 microseconds)
 * Batch transmission: 10 samples per POST (every 40 ms)
 * Protocol: HTTPS POST with 'x-device-token' header
 * Payload format: {"samples": [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9]}
 * 
 * Zero external library dependencies (uses built-in ESP32 WiFi & HTTPClient)
 * ==============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ----------------- CONFIGURATION -----------------
// IMPORTANT: ESP32 only supports 2.4 GHz Wi-Fi!
// If using a phone hotspot, ensure "Maximize Compatibility" (iPhone)
// or "2.4 GHz Band" (Android) is ENABLED!
const char* WIFI_SSID     = "Nihal Kumar";
const char* WIFI_PASSWORD = "123456780";

// Your Railway Cloud Server URL (no trailing slash, no brackets)
const char* RAILWAY_URL   = "https://nurasense-production.up.railway.app";

// The device token registered in your NuraSense dashboard
const char* DEVICE_TOKEN  = "ESP32_BIOAMP_01";

// Pin Configuration:
// Use ADC1 pins (GPIO 34, 35, 36, 39) - ADC2 cannot be used when Wi-Fi is enabled!
#define ECG_PIN           34     // Analog input from ECG sensor OUT
#define LED_PIN           2      // Status LED (GPIO 2 on most ESP32 boards)

// Set to true ONLY if you wired LO+ and LO- on AD8232.
// For BioAmp BisCute (3-pin: VCC, GND, OUT), leave this false!
#define ENABLE_LEADS_OFF  false
#define LO_PLUS_PIN       32     // Leads-off detect + [AD8232 only]
#define LO_MINUS_PIN      33     // Leads-off detect - [AD8232 only]

// Sampling Parameters
const unsigned long SAMPLE_INTERVAL_US = 4000; // 250 Hz = 4000 microseconds
const int BATCH_SIZE = 10;                     // 10 samples per batch = 40ms window

// Rolling sample batch
int sampleBatch[BATCH_SIZE];
int sampleIndex = 0;
unsigned long lastSampleTime = 0;
unsigned long lastWifiRetryTime = 0;

// Reusable secure client for low-latency HTTPS Keep-Alive
WiFiClientSecure client;
HTTPClient http;
String ingestEndpoint;

void printWifiDiagnosis() {
  wl_status_t status = WiFi.status();
  Serial.print("[WiFi Status] ");
  switch (status) {
    case WL_NO_SSID_AVAIL:
      Serial.println("SSID NOT FOUND! Make sure your hotspot is ON and set to 2.4 GHz (not 5 GHz).");
      break;
    case WL_CONNECT_FAILED:
      Serial.println("PASSWORD INCORRECT or connection rejected.");
      break;
    case WL_DISCONNECTED:
      Serial.println("Disconnected / connecting...");
      break;
    case WL_IDLE_STATUS:
      Serial.println("Idle...");
      break;
    default:
      Serial.print("Code: ");
      Serial.println((int)status);
      break;
  }
}

void connectWiFi() {
  Serial.println();
  Serial.print("[WiFi] Connecting to '");
  Serial.print(WIFI_SSID);
  Serial.println("'...");

  // Reset WiFi stack cleanly to avoid 'sta is connecting, cannot set config'
  WiFi.disconnect(true, true);
  delay(200);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(300);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("[WiFi] Connected successfully!");
    Serial.print("[WiFi] IP Address: ");
    Serial.println(WiFi.localIP());
    digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.println();
    Serial.println("[WiFi] Connection attempt timed out.");
    printWifiDiagnosis();
    digitalWrite(LED_PIN, LOW);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("==================================================");
  Serial.println("   NuraSense TPP — ESP32 Cloud ECG Streamer       ");
  Serial.println("   Sampling: 250 Hz | Batch: 10 samples (40ms)    ");
  Serial.println("==================================================");

  pinMode(LED_PIN, OUTPUT);
  pinMode(ECG_PIN, INPUT);

  #if ENABLE_LEADS_OFF
  pinMode(LO_PLUS_PIN, INPUT_PULLDOWN);
  pinMode(LO_MINUS_PIN, INPUT_PULLDOWN);
  #endif

  // Set ESP32 ADC resolution (12-bit: 0 - 4095)
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db); // Full range ~0 - 3.3V

  // Build full HTTPS endpoint
  ingestEndpoint = String(RAILWAY_URL) + "/ingest";
  Serial.print("[Cloud] Ingest Endpoint: ");
  Serial.println(ingestEndpoint);
  Serial.print("[Cloud] Device Token: ");
  Serial.println(DEVICE_TOKEN);

  // Insecure SSL client (skips CA verification for high-frequency embedded telemetry)
  client.setInsecure();
  client.setTimeout(2); // 2-second timeout

  connectWiFi();
  lastSampleTime = micros();
}

void sendBatchToCloud() {
  // If not connected to WiFi, skip batch and do not spam reconnect
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  // Build JSON payload: {"samples":[s0,s1,...,s9]}
  String requestBody = "{\"samples\":[";
  for (int i = 0; i < BATCH_SIZE; i++) {
    requestBody += String(sampleBatch[i]);
    if (i < BATCH_SIZE - 1) {
      requestBody += ",";
    }
  }
  requestBody += "]}";

  // Send HTTPS POST to Railway /ingest
  http.begin(client, ingestEndpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", DEVICE_TOKEN);
  http.setReuse(true); // Keep connection alive for minimal latency

  int httpResponseCode = http.POST(requestBody);

  if (httpResponseCode > 0) {
    if (httpResponseCode != 200) {
      Serial.print("[Cloud] HTTP Status: ");
      Serial.println(httpResponseCode);
      String response = http.getString();
      Serial.println(response);
    }
  } else {
    // Only log occasionally to avoid flooding serial buffer
    static unsigned long lastErrorLog = 0;
    if (millis() - lastErrorLog > 3000) {
      lastErrorLog = millis();
      Serial.print("[Cloud] POST failed, error: ");
      Serial.println(http.errorToString(httpResponseCode).c_str());
    }
  }

  http.end();
}

void loop() {
  unsigned long currentMicros = micros();

  // Strict 250 Hz sampling (every 4000 microseconds)
  if (currentMicros - lastSampleTime >= SAMPLE_INTERVAL_US) {
    lastSampleTime += SAMPLE_INTERVAL_US;

    int rawValue = 0;

    #if ENABLE_LEADS_OFF
    bool leadsOff = (digitalRead(LO_PLUS_PIN) == HIGH || digitalRead(LO_MINUS_PIN) == HIGH);
    if (leadsOff) {
      rawValue = 0;
    } else {
      rawValue = analogRead(ECG_PIN);
    }
    #else
    rawValue = analogRead(ECG_PIN);
    #endif

    // Store in rolling 10-sample batch buffer
    sampleBatch[sampleIndex] = rawValue;
    sampleIndex++;

    // When 10 samples are accumulated (40 ms), post to cloud
    if (sampleIndex >= BATCH_SIZE) {
      sampleIndex = 0;
      sendBatchToCloud();
    }
  }

  // Non-blocking WiFi reconnect check every 8 seconds
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiRetryTime > 8000) {
      lastWifiRetryTime = millis();
      Serial.println("[WiFi] Lost connection. Attempting clean reconnect...");
      WiFi.disconnect(false);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }

  yield();
}
