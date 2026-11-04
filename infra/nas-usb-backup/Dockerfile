FROM docker:cli
RUN apk add --no-cache restic sqlite tzdata
COPY backup.sh /backup.sh
RUN chmod 755 /backup.sh
CMD ["/backup.sh"]
