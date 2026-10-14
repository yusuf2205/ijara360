# Offsite copies (docs/M6-OFFSITE.md): age encrypts on the NAS, rclone sends to Google Drive.
# Alpine already ships the CA bundle rclone needs for TLS.
FROM alpine:3.22
RUN apk add --no-cache rclone age tar coreutils
COPY scripts/offsite-service.sh /opt/ijara360/offsite-service.sh
CMD ["sh", "/opt/ijara360/offsite-service.sh", "loop"]
