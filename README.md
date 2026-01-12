# mqtt-mqtt-duplicator

Duplicate MQTT topics from a source broker to a destination broker (RabbitMQ MQTT).

This repository has been created as part of the [Waltti APC](https://github.com/tvv-lippu-ja-maksujarjestelma-oy/waltti-apc) project.

## Development

1. Create a suitable `.env` file for configuration.
   Check below for the configuration reference.
1. Create any necessary secrets that the `.env` file points to.
1. Install dependencies:

   ```sh
   npm install
   ```

1. Run linters and tests and build:

   ```sh
   npm run check-and-build
   ```

1. Load the environment variables:

   ```sh
   set -a
   source .env
   set +a
   ```

1. Run the application:

   ```sh
   npm start
   ```

## Docker

Build your own Docker image or publish under your registry.

## Configuration

| Environment variable                  | Required? | Default | Description                                              |
| ------------------------------------- | --------- | ------- | -------------------------------------------------------- |
| `HEALTH_CHECK_PORT`                   | No        | `8080`  | Health endpoint port.                                    |
| `SOURCE_MQTT_URL`                     | Yes       |         | Source broker URL.                                       |
| `SOURCE_MQTT_USERNAME_PATH`           | No        |         | File path for source username (with password path).      |
| `SOURCE_MQTT_PASSWORD_PATH`           | No        |         | File path for source password (with username path).      |
| `SOURCE_MQTT_CLIENT_ID_PREFIX`        | Yes       |         | Client ID prefix for source.                             |
| `SOURCE_MQTT_CLIENT_ID_SUFFIX_LENGTH` | No        | `0`     | Random suffix length for source Client ID.               |
| `SOURCE_MQTT_TOPIC_FILTER`            | Yes       |         | Topic filter to subscribe (e.g. `apc-from-vehicle/#`).   |
| `SOURCE_MQTT_QOS`                     | No        | `2`     | Subscription QoS.                                        |
| `SOURCE_MQTT_CLEAN_SESSION`           | No        | `false` | Use clean session at source.                             |
| `DEST_MQTT_URL`                       | Yes       |         | Destination (RabbitMQ MQTT) URL.                         |
| `DEST_MQTT_USERNAME_PATH`             | No        |         | File path for destination username (with password path). |
| `DEST_MQTT_PASSWORD_PATH`             | No        |         | File path for destination password (with username path). |
| `DEST_MQTT_CLIENT_ID_PREFIX`          | Yes       |         | Client ID prefix for destination.                        |
| `DEST_MQTT_CLIENT_ID_SUFFIX_LENGTH`   | No        | `0`     | Random suffix length for destination Client ID.          |
| `DEST_MQTT_CLEAN_SESSION`             | No        | `true`  | Use clean session at destination.                        |
| `FORWARD_QOS_MAX`                     | No        | `1`     | Upper bound for publish QoS (uses min with incoming).    |
| `FORWARD_RETAIN`                      | No        | `true`  | Whether to forward retained flag.                        |
| `SAVE_MESSAGES_TO_FILE`               | No        | `false` | If `true`, saves each message to an NDJSON file.         |
| `SAVE_MESSAGES_FILE_PATH`            | No        | `./messages.ndjson` | Output path for the NDJSON log.                 |

### Saving messages to file (NDJSON)

When `SAVE_MESSAGES_TO_FILE=true`, the service appends one JSON object per line to `SAVE_MESSAGES_FILE_PATH` (default `./messages.ndjson`). Each record contains:

- `time` (ISO string)
- `topic`
- `incomingQos`, `incomingRetain`, `dup`
- `payloadEncoding` (either `utf8` or `base64`)
- `payload` (UTF-8 text or Base64 string depending on encoding)

Example record:

```json
{"time":"2025-10-30T16:05:00.123Z","topic":"apc-from-vehicle/v1/...","incomingQos":1,"incomingRetain":false,"dup":false,"payloadEncoding":"utf8","payload":"{\"...\":\"...\"}"}
```
