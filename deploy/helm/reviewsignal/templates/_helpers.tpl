{{/*
Chart name.
*/}}
{{- define "reviewsignal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, at most 63 characters minus room for suffixes.
*/}}
{{- define "reviewsignal.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 50 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "reviewsignal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "reviewsignal.labels" -}}
helm.sh/chart: {{ include "reviewsignal.chart" . }}
{{ include "reviewsignal.selectorLabels" . }}
app.kubernetes.io/version: {{ include "reviewsignal.imageTag" . | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: loomit
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels shared by every component.
*/}}
{{- define "reviewsignal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "reviewsignal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component labels. Usage: include "reviewsignal.componentLabels" (list . "api")
*/}}
{{- define "reviewsignal.componentLabels" -}}
{{ include "reviewsignal.labels" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{- define "reviewsignal.componentSelectorLabels" -}}
{{ include "reviewsignal.selectorLabels" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{- define "reviewsignal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "reviewsignal.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "reviewsignal.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{- define "reviewsignal.image" -}}
{{- $repo := required "image.repository is required (ECR repository URI)" .Values.image.repository }}
{{- if .Values.image.digest }}
{{- printf "%s@%s" $repo .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" $repo (include "reviewsignal.imageTag" .) }}
{{- end }}
{{- end }}

{{- define "reviewsignal.configMapName" -}}
{{- printf "%s-config" (include "reviewsignal.fullname" .) }}
{{- end }}

{{/*
Secret with runtime credentials: the ExternalSecret target or an existing Secret.
*/}}
{{- define "reviewsignal.secretName" -}}
{{- if .Values.externalSecrets.enabled }}
{{- printf "%s-env" (include "reviewsignal.fullname" .) }}
{{- else }}
{{- required "secrets.existingSecret is required when externalSecrets.enabled=false" .Values.secrets.existingSecret }}
{{- end }}
{{- end }}

{{- define "reviewsignal.migrateSecretName" -}}
{{- if .Values.externalSecrets.enabled }}
{{- printf "%s-migrate" (include "reviewsignal.fullname" .) }}
{{- else }}
{{- include "reviewsignal.secretName" . }}
{{- end }}
{{- end }}

{{/*
Merged non-secret configuration with empty values removed.
*/}}
{{- define "reviewsignal.config" -}}
{{- $config := dict }}
{{- range $key, $value := .Values.config }}
{{- if ne (toString $value) "" }}
{{- $_ := set $config $key (toString $value) }}
{{- end }}
{{- end }}
{{- range $key, $value := .Values.extraConfig }}
{{- if ne (toString $value) "" }}
{{- $_ := set $config $key (toString $value) }}
{{- end }}
{{- end }}
{{- toYaml $config }}
{{- end }}

{{/*
Fail early on configuration the service would reject at runtime.
*/}}
{{- define "reviewsignal.validate" -}}
{{- $c := .Values.config }}
{{- if eq (toString $c.AUTH_MODE) "oidc" }}
{{- if or (empty $c.OIDC_ISSUER) (empty $c.OIDC_AUDIENCE) (empty $c.OIDC_JWKS_URL) }}
{{- fail "config.OIDC_ISSUER, config.OIDC_AUDIENCE and config.OIDC_JWKS_URL are required when AUTH_MODE=oidc" }}
{{- end }}
{{- else if eq (toString $c.AUTH_MODE) "dev" }}
{{- if eq (toString $c.NODE_ENV) "production" }}
{{- fail "AUTH_MODE=dev is for local development only; use oidc" }}
{{- end }}
{{- else }}
{{- fail "config.AUTH_MODE must be oidc or dev" }}
{{- end }}
{{- if eq (toString $c.SECRET_STORE) "aws" }}
{{- if empty $c.AWS_REGION }}
{{- fail "config.AWS_REGION is required when SECRET_STORE=aws" }}
{{- end }}
{{- else if eq (toString $c.SECRET_STORE) "database" }}
{{- if eq (toString $c.NODE_ENV) "production" }}
{{- fail "SECRET_STORE=database is for non-production use only; use aws" }}
{{- end }}
{{- else }}
{{- fail "config.SECRET_STORE must be aws or database" }}
{{- end }}
{{- if and (eq (toString $c.CLASSIFIER_PROVIDER) "openrouter") (empty $c.OPENROUTER_MODEL) }}
{{- fail "config.OPENROUTER_MODEL must pin a model when CLASSIFIER_PROVIDER=openrouter" }}
{{- end }}
{{- if and .Values.externalSecrets.enabled (empty .Values.externalSecrets.remoteKey) }}
{{- fail "externalSecrets.remoteKey is required when externalSecrets.enabled=true" }}
{{- end }}
{{- end }}

{{/*
Pod-level fields shared by the API and the worker.
Usage: include "reviewsignal.podCommon" .
*/}}
{{- define "reviewsignal.podCommon" -}}
serviceAccountName: {{ include "reviewsignal.serviceAccountName" . }}
# IRSA and the Istio sidecar use their own projected tokens.
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . }}
{{- end }}
securityContext:
{{ toYaml .Values.podSecurityContext | indent 2 }}
{{- end }}

{{/*
Topology spread for a component. Usage: include "reviewsignal.topologySpread" (list . "api" .Values.api)
*/}}
{{- define "reviewsignal.topologySpread" -}}
{{- $root := index . 0 }}
{{- $component := index . 1 }}
{{- $spec := index . 2 }}
{{- if $spec.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ $spec.topologySpread.maxSkew }}
    topologyKey: {{ $spec.topologySpread.topologyKey }}
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
{{ include "reviewsignal.componentSelectorLabels" (list $root $component) | indent 8 }}
{{- end }}
{{- end }}
