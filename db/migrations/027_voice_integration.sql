-- VOICE-PRO-01: a voice provider (Yandex SpeechKit) among the salon's own integrations.
ALTER TABLE tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_kind_check;
ALTER TABLE tenant_integrations ADD CONSTRAINT tenant_integrations_kind_check CHECK (kind IN ('telegram', 'sms', 'fiscal', 'acquiring', 'telephony', 'voice'));
