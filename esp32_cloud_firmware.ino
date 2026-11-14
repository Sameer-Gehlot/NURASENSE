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
 * ==============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

// ----------------- CONFIGURATION (EDIT THESE) -----------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Your Railway Cloud Server URL (no trailing slash)
// Example: "https://nurasense-production.up.railway.app"
const char* RAILWAY_URL   = "https://YOUR_RAILWAY_URL";

// The device token registered in your NuraSense dashboard
// (Pair this in NuraSense Dashboard -> Pair Device)
const char* DEVICE_TOKEN  = "ESP32_BIOAMP_01";

// Pin Configuration:
// Use ADC1 pins (GPIO 34, 35, 36, 39) - ADC2 cannot be used when Wi-Fi is enabled!
#define ECG_PIN           34     // Analog input from ECG sensor OUT
#define LED_PIN           2      // Status LED (GPIO 2 on most ESP32 boards)
#define LO_PLUS_PIN       32     // Leads-off detect + (AD8232 LO+) [Optional]
#define LO_MINUS_PIN      33     // Leads-off detect - (AD8232 LO-) [Optional]

// Sampling Parameters
const unsigned long SAMPLE_INTERVAL_US = 4000; // 250 Hz = 4000 microseconds
const int BATCH_SIZE = 10;                     // 10 samples per batch = 40ms window

// Rolling sample batch
int sampleBatch[BATCH_SIZE];
int sampleIndex = 0;
unsigned long lastSampleTime = 0;
unsigned long lastBatchPostTime = 0;

// Reusable secure client for low-latency HTTPS Keep-Alive
WiFiClientSecure client;
HTTPClient http;
String ingestEndpoint;

void connectWiFi() {
  Serial.println();
  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(250);
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
    Serial.println("[WiFi] Connection failed. Will retry in loop.");
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
  
  // Optional Leads-off inputs
  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);

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
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Cloud] WiFi disconnected. Reconnecting...");
    connectWiFi();
    return;
  }

  // Build JSON payload: {"samples": [s0, s1, ..., s9]}
  StaticJsonDocument<256> doc;
  JsonArray samplesArray = doc.createNestedArray("samples");
  for (int i = 0; i < BATCH_SIZE; i++) {
    samplesArray.add(sampleBatch[i]);
  }

  String requestBody;
  serializeJson(doc, requestBody);

  // Send HTTPS POST to Railway /ingest
  http.begin(client, ingestEndpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", DEVICE_TOKEN);
  http.setReuse(true); // Keep connection alive for minimal latency

  int httpResponseCode = http.POST(requestBody);

  if (httpResponseCode > 0) {
    // 200 OK
    if (httpResponseCode == 200) {
      // Batch acknowledged by NuraSense cloud engine
    } else {
      Serial.print("[Cloud] HTTP Status: ");
      Serial.println(httpResponseCode);
      String response = http.getString();
      Serial.println(response);
    }
  } else {
    Serial.print("[Cloud] POST failed, error: ");
    Serial.println(http.errorToString(httpResponseCode).c_str());
  }

  http.end();
}

void loop() {
  unsigned long currentMicros = micros();

  // Strict 250 Hz sampling (every 4000 microseconds)
  if (currentMicros - lastSampleTime >= SAMPLE_INTERVAL_US) {
    lastSampleTime += SAMPLE_INTERVAL_US;

    // Optional leads-off detection
    // If either LO+ or LO- is HIGH, electrodes are disconnected
    bool leadsOff = (digitalRead(LO_PLUS_PIN) == HIGH || digitalRead(LO_MINUS_PIN) == HIGH);

    int rawValue = 0;
    if (leadsOff) {
      rawValue = 0; // Flatline if electrodes detached
    } else {
      rawValue = analogRead(ECG_PIN);
    }

    // Store in rolling 10-sample batch buffer
    sampleBatch[sampleIndex] = rawValue;
    sampleIndex++;

    // When 10 samples are accumulated (40 ms), post to cloud
    if (sampleIndex >= BATCH_SIZE) {
      sampleIndex = 0;
      sendBatchToCloud();
    }
  }

  // Yield to allow ESP32 WiFi background tasks to run smoothly
  yield();
}
