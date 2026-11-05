# VOICE-LOCAL-01: our own Russian voice (Piper, MIT). No keys, no foreign services, runs on the CRM server.
FROM python:3.12-slim
RUN pip install --no-cache-dir piper-tts==1.8.0
WORKDIR /voices
# Voices are fetched once at build. A failed download does not break the deploy: the CRM falls back to the browser voice.
RUN for v in irina denis dmitri ruslan; do \
      python -m piper.download_voices --data-dir /voices "ru_RU-$v-medium" || echo "voice $v not downloaded"; \
    done; ls -la /voices
COPY server.py /app/server.py
EXPOSE 5002
CMD ["python", "/app/server.py"]
