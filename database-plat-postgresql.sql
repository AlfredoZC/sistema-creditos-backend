-- ============================================================================
--  PLATAFORMA DE CIRUGIA A CREDITO
--  DBMS       : PostgreSQL 13+   (usa gen_random_uuid(), nativo desde PG13)
--  Convertido : 29-jul-2026, desde database-plat.sql (MySQL / Enterprise Architect)
--
--  Decisiones de conversion:
--   * enum            -> VARCHAR + CHECK (valores de negocio evolucionan)
--   * uuid            -> UUID NOT NULL DEFAULT gen_random_uuid()
--   * timestamptz     -> se mantiene (eventos); date solo en fechas de calendario
--   * "Pago"          -> pago (minusculas, convencion PostgreSQL)
--   * Se agregan PKs, FKs, UNIQUEs, DEFAULTs e indices que EA no exporto
--   * Columnas agregadas porque el conector EXISTE en el diagrama pero EA
--     se comio la columna: cirugia.paciente_id, cirugia.catalogo_cirugia_id
--   * Campos incorporados tras actualizacion del modelo EA (29-jul), con
--     correccion de tipos segun lo acordado:
--       cuota.fecha_vencimiento   VARCHAR(50) -> DATE
--       cuota.estado              VARCHAR(50) -> VARCHAR(15) + CHECK
--       pago.monto                NUMERIC     -> NUMERIC(10,2)
--       pago.tipo                 VARCHAR(50) -> VARCHAR(25) + CHECK
--       mensaje_bot.timestamp     VARCHAR(50) -> TIMESTAMPTZ DEFAULT now()
--       mensaje_bot.tipo_mensaje  VARCHAR(50) -> VARCHAR(20) + CHECK
--       envio_whatsapp.variables  VARCHAR(4)  -> JSONB NULL
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- DROP en orden inverso de dependencias
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS auditoria         CASCADE;
DROP TABLE IF EXISTS mensaje_bot       CASCADE;
DROP TABLE IF EXISTS conversacion_bot  CASCADE;
DROP TABLE IF EXISTS envio_whatsapp    CASCADE;
DROP TABLE IF EXISTS plantilla_mensaje CASCADE;
DROP TABLE IF EXISTS pago              CASCADE;
DROP TABLE IF EXISTS metodo_pago       CASCADE;
DROP TABLE IF EXISTS cuota             CASCADE;
DROP TABLE IF EXISTS plan_pago         CASCADE;
DROP TABLE IF EXISTS cirugia_medica    CASCADE;
DROP TABLE IF EXISTS cirugia           CASCADE;
DROP TABLE IF EXISTS catalogo_cirugia  CASCADE;
DROP TABLE IF EXISTS medico            CASCADE;
DROP TABLE IF EXISTS paciente          CASCADE;
DROP TABLE IF EXISTS usuario           CASCADE;

-- ----------------------------------------------------------------------------
-- USUARIO (solo autenticacion; oficina/admin/medico siempre tienen cuenta,
-- el paciente puede no tenerla -> paciente.usuario_id es nullable)
-- ----------------------------------------------------------------------------
CREATE TABLE usuario
(
    usuario_id   UUID         NOT NULL DEFAULT gen_random_uuid(),
    email        VARCHAR(255) NOT NULL,
    password     VARCHAR(255) NOT NULL,
    nombre       VARCHAR(50)  NOT NULL,
    roles        VARCHAR(20)  NOT NULL,
    esta_activo  BOOLEAN      NOT NULL DEFAULT TRUE,

    CONSTRAINT pk_usuario       PRIMARY KEY (usuario_id),
    CONSTRAINT uq_usuario_email UNIQUE (email),
    CONSTRAINT chk_usuario_roles
        CHECK (roles IN ('paciente', 'medico', 'oficina', 'admin'))
);

-- ----------------------------------------------------------------------------
-- PACIENTE (cuenta opcional; el bot lo identifica por telefono)
-- ----------------------------------------------------------------------------
CREATE TABLE paciente
(
    paciente_id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    usuario_id          UUID        NULL,   -- NULL = sin cuenta web (modelo hibrido)
    documento_identidad VARCHAR(20) NOT NULL,  -- 2da verificacion del bot
    nombre              VARCHAR(50) NOT NULL,
    paterno             VARCHAR(50) NOT NULL,
    materno             VARCHAR(50) NULL,
    fecha_nacimiento    DATE        NULL,
    direccion           VARCHAR(100) NULL,
    telefono            VARCHAR(50) NOT NULL,  -- identidad en WhatsApp

    CONSTRAINT pk_paciente            PRIMARY KEY (paciente_id),
    CONSTRAINT uq_paciente_usuario    UNIQUE (usuario_id),
    CONSTRAINT uq_paciente_documento  UNIQUE (documento_identidad),
    CONSTRAINT uq_paciente_telefono   UNIQUE (telefono),
    CONSTRAINT fk_paciente_usuario    FOREIGN KEY (usuario_id)
        REFERENCES usuario (usuario_id)
);

-- ----------------------------------------------------------------------------
-- MEDICO (cuenta obligatoria: el panel medico es su herramienta de trabajo)
-- ----------------------------------------------------------------------------
CREATE TABLE medico
(
    medico_id             UUID NOT NULL DEFAULT gen_random_uuid(),
    usuario_id            UUID NOT NULL,
    especialidad          TEXT NOT NULL,
    matricula_profesional TEXT NOT NULL,

    CONSTRAINT pk_medico            PRIMARY KEY (medico_id),
    CONSTRAINT uq_medico_usuario    UNIQUE (usuario_id),
    CONSTRAINT uq_medico_matricula  UNIQUE (matricula_profesional),
    CONSTRAINT fk_medico_usuario    FOREIGN KEY (usuario_id)
        REFERENCES usuario (usuario_id)
);

-- ----------------------------------------------------------------------------
-- CATALOGO_CIRUGIA
-- ----------------------------------------------------------------------------
CREATE TABLE catalogo_cirugia
(
    catalogo_cirugia_id UUID          NOT NULL DEFAULT gen_random_uuid(),
    nombre              VARCHAR(50)   NOT NULL,
    descripcion         TEXT          NULL,
    costo_base          NUMERIC(10,2) NOT NULL,

    CONSTRAINT pk_catalogo_cirugia PRIMARY KEY (catalogo_cirugia_id),
    CONSTRAINT chk_catalogo_costo  CHECK (costo_base >= 0)
);

-- ----------------------------------------------------------------------------
-- CIRUGIA
-- (paciente_id y catalogo_cirugia_id agregadas: los conectores existian
--  en el diagrama EA pero las columnas no se exportaron)
-- ----------------------------------------------------------------------------
CREATE TABLE cirugia
(
    cirugia_id          UUID          NOT NULL DEFAULT gen_random_uuid(),
    paciente_id         UUID          NOT NULL,
    catalogo_cirugia_id UUID          NOT NULL,
    fecha_programada    DATE          NOT NULL,
    costo_total         NUMERIC(10,2) NOT NULL,
    estado              VARCHAR(20)   NOT NULL DEFAULT 'programada',
    observaciones       TEXT          NULL,

    CONSTRAINT pk_cirugia        PRIMARY KEY (cirugia_id),
    CONSTRAINT fk_cirugia_paciente  FOREIGN KEY (paciente_id)
        REFERENCES paciente (paciente_id),
    CONSTRAINT fk_cirugia_catalogo  FOREIGN KEY (catalogo_cirugia_id)
        REFERENCES catalogo_cirugia (catalogo_cirugia_id),
    CONSTRAINT chk_cirugia_estado
        CHECK (estado IN ('programada', 'realizada', 'cancelada')),
    CONSTRAINT chk_cirugia_costo CHECK (costo_total >= 0)
);

-- ----------------------------------------------------------------------------
-- CIRUGIA_MEDICA  (N:M -> una cirugia puede tener varios medicos)
--  rol: no es lo mismo ser el cirujano principal que colaborar (asistente
--  o anestesiologo). El panel del medico distingue ambos casos.
-- ----------------------------------------------------------------------------
CREATE TABLE cirugia_medica
(
    cirugia_medica_id UUID NOT NULL DEFAULT gen_random_uuid(),
    cirugia_id        UUID NOT NULL,
    medico_id         UUID NOT NULL,
    rol               VARCHAR(20) NOT NULL DEFAULT 'principal',

    CONSTRAINT pk_cirugia_medica PRIMARY KEY (cirugia_medica_id),
    CONSTRAINT uq_cirugia_medico UNIQUE (cirugia_id, medico_id),
    CONSTRAINT fk_cm_cirugia FOREIGN KEY (cirugia_id)
        REFERENCES cirugia (cirugia_id),
    CONSTRAINT fk_cm_medica  FOREIGN KEY (medico_id)
        REFERENCES medico (medico_id),
    CONSTRAINT chk_cm_rol
        CHECK (rol IN ('principal', 'asistente', 'anestesiologo'))
);

-- Regla de negocio: UNA sola cirugia puede tener UN solo cirujano principal.
-- Indice parcial unico (solo aplica a las filas con rol = 'principal')
CREATE UNIQUE INDEX uq_un_principal_por_cirugia
    ON cirugia_medica (cirugia_id)
    WHERE rol = 'principal';

-- ----------------------------------------------------------------------------
-- PLAN_PAGO (contado = 1 cuota sin interes; credito = N cuotas con interes)
-- ----------------------------------------------------------------------------
CREATE TABLE plan_pago
(
    plan_pago_id         UUID          NOT NULL DEFAULT gen_random_uuid(),
    cirugia_id           UUID          NOT NULL,  -- UNIQUE: un plan por cirugia
    tipo_plan            VARCHAR(10)   NOT NULL,
    cuota_inicial        NUMERIC(10,2) NOT NULL DEFAULT 0,
    monto_financiado     NUMERIC(10,2) NOT NULL,
    tasa_interes_mensual NUMERIC(10,2) NOT NULL DEFAULT 2.00,
    numero_cuotas        INT           NOT NULL,
    fecha_inicio         DATE          NOT NULL,
    saldo_pendiente      NUMERIC(10,2) NOT NULL,
    estado               VARCHAR(20)   NOT NULL DEFAULT 'activo',

    CONSTRAINT pk_plan_pago        PRIMARY KEY (plan_pago_id),
    CONSTRAINT uq_plan_cirugia     UNIQUE (cirugia_id),
    CONSTRAINT fk_plan_cirugia     FOREIGN KEY (cirugia_id)
        REFERENCES cirugia (cirugia_id),
    CONSTRAINT chk_plan_tipo   CHECK (tipo_plan IN ('contado', 'credito')),
    CONSTRAINT chk_plan_estado CHECK (estado IN ('activo', 'completado', 'en_mora', 'cancelado')),
    CONSTRAINT chk_plan_cuotas CHECK (numero_cuotas > 0),
    CONSTRAINT chk_plan_montos CHECK (monto_financiado >= 0 AND saldo_pendiente >= 0 AND cuota_inicial >= 0)
);

-- ----------------------------------------------------------------------------
-- CUOTA (monto_pagado = acumulador de abonos parciales)
-- ----------------------------------------------------------------------------
CREATE TABLE cuota
(
    cuota_id       UUID          NOT NULL DEFAULT gen_random_uuid(),
    plan_pago_id   UUID          NOT NULL,
    numero_cuota   INT           NOT NULL,
    monto_capital  NUMERIC(10,2) NOT NULL,
    monto_interes  NUMERIC(10,2) NOT NULL DEFAULT 0,
    monto_total    NUMERIC(10,2) NOT NULL,
    monto_pagado   NUMERIC(10,2) NOT NULL DEFAULT 0,
    fecha_vencimiento DATE       NOT NULL,
    estado         VARCHAR(15)   NOT NULL DEFAULT 'pendiente',

    CONSTRAINT pk_cuota         PRIMARY KEY (cuota_id),
    CONSTRAINT uq_cuota_numero  UNIQUE (plan_pago_id, numero_cuota),
    CONSTRAINT fk_cuota_plan    FOREIGN KEY (plan_pago_id)
        REFERENCES plan_pago (plan_pago_id),
    CONSTRAINT chk_cuota_montos CHECK (monto_pagado >= 0),
    CONSTRAINT chk_cuota_estado
        CHECK (estado IN ('pendiente', 'parcial', 'pagada', 'vencida'))
);

-- ----------------------------------------------------------------------------
-- METODO_PAGO (catalogo administrable por la oficina)
-- ----------------------------------------------------------------------------
CREATE TABLE metodo_pago
(
    metodo_pago_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
    metodo          VARCHAR(50) NOT NULL,
    esta_habilitado BOOLEAN     NOT NULL DEFAULT TRUE,
    descripcion     TEXT        NULL,

    CONSTRAINT pk_metodo_pago     PRIMARY KEY (metodo_pago_id),
    CONSTRAINT uq_metodo_pago_nom UNIQUE (metodo)
);

-- ----------------------------------------------------------------------------
-- PAGO
--  * cuota_id NULL            -> amortizacion a capital (va directo al plan)
--  * paciente_usuario_id NULL -> paciente sin cuenta web
--  * oficina_usuario_id       -> quien registro el cobro (registrado_por)
-- ----------------------------------------------------------------------------
CREATE TABLE pago
(
    pago_id             UUID        NOT NULL DEFAULT gen_random_uuid(),
    plan_pago_id        UUID        NOT NULL,
    cuota_id            UUID        NULL,
    paciente_usuario_id UUID        NULL,
    oficina_usuario_id  UUID        NOT NULL,
    metodo_pago_id      UUID          NOT NULL,
    monto               NUMERIC(10,2) NOT NULL,
    tipo                VARCHAR(25)   NOT NULL,
    modalidad_amortizacion VARCHAR(20) NULL,  -- solo si tipo = amortizacion_capital
    fecha_pago          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    comprobante_url     TEXT        NULL,
    estado              VARCHAR(25) NOT NULL DEFAULT 'pendiente_confirmacion',

    CONSTRAINT pk_pago PRIMARY KEY (pago_id),
    CONSTRAINT fk_pago_plan     FOREIGN KEY (plan_pago_id)
        REFERENCES plan_pago (plan_pago_id),
    CONSTRAINT fk_pago_cuota    FOREIGN KEY (cuota_id)
        REFERENCES cuota (cuota_id),
    CONSTRAINT fk_pago_paciente FOREIGN KEY (paciente_usuario_id)
        REFERENCES usuario (usuario_id),
    CONSTRAINT fk_pago_oficina  FOREIGN KEY (oficina_usuario_id)
        REFERENCES usuario (usuario_id),
    CONSTRAINT fk_pago_metodo   FOREIGN KEY (metodo_pago_id)
        REFERENCES metodo_pago (metodo_pago_id),
    CONSTRAINT chk_pago_estado
        CHECK (estado IN ('pendiente_confirmacion', 'confirmado', 'rechazado')),
    CONSTRAINT chk_pago_monto CHECK (monto > 0),
    CONSTRAINT chk_pago_tipo
        CHECK (tipo IN ('cuota_inicial', 'pago_cuota', 'amortizacion_capital')),
    -- Regla de negocio a nivel BD: la amortizacion a capital NUNCA lleva
    -- cuota (va directo al saldo del plan)
    CONSTRAINT chk_pago_amort_sin_cuota
        CHECK (tipo <> 'amortizacion_capital' OR cuota_id IS NULL),
    -- ...y un pago de cuota SIEMPRE referencia su cuota
    CONSTRAINT chk_pago_cuota_con_cuota
        CHECK (tipo <> 'pago_cuota' OR cuota_id IS NOT NULL),
    -- Modalidad de amortizacion: al adelantar capital el paciente elige
    -- reducir la cuota (default) o reducir el plazo
    CONSTRAINT chk_pago_modalidad
        CHECK (modalidad_amortizacion IN ('reducir_cuota', 'reducir_plazo')),
    CONSTRAINT chk_pago_modalidad_amort
        CHECK ((tipo = 'amortizacion_capital' AND modalidad_amortizacion IS NOT NULL)
            OR (tipo <> 'amortizacion_capital' AND modalidad_amortizacion IS NULL))
);

-- ----------------------------------------------------------------------------
-- PLANTILLA_MENSAJE (plantillas aprobadas por Meta)
-- ----------------------------------------------------------------------------
CREATE TABLE plantilla_mensaje
(
    plantilla_mensaje_id UUID        NOT NULL DEFAULT gen_random_uuid(),
    nombre               VARCHAR(50) NOT NULL,
    tipo                 VARCHAR(30) NOT NULL,
    contenido            TEXT        NOT NULL,  -- string con {placeholders}

    CONSTRAINT pk_plantilla PRIMARY KEY (plantilla_mensaje_id),
    CONSTRAINT chk_plantilla_tipo
        CHECK (tipo IN ('recordatorio_3_dias', 'recordatorio_vencimiento',
                        'aviso_mora', 'bienvenida', 'confirmacion_pago'))
);

-- ----------------------------------------------------------------------------
-- ENVIO_WHATSAPP (log de recordatorios enviados)
-- ----------------------------------------------------------------------------
CREATE TABLE envio_whatsapp
(
    envio_whatsapp_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
    paciente_id         UUID        NOT NULL,
    cuota_id            UUID        NULL,   -- NULL si no refiere a una cuota
    plantilla_id        UUID        NOT NULL,
    mensaje_final       TEXT        NOT NULL,  -- ya con variables reemplazadas
    variables           JSONB       NULL,      -- {"nombre":"Maria","monto":"1113.27"}
    whatsapp_message_id VARCHAR(100) NULL,     -- lo devuelve Meta al enviar
    estado              VARCHAR(20) NOT NULL DEFAULT 'enviado',
    fecha_envio         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_envio PRIMARY KEY (envio_whatsapp_id),
    CONSTRAINT fk_envio_paciente  FOREIGN KEY (paciente_id)
        REFERENCES paciente (paciente_id),
    CONSTRAINT fk_envio_cuota     FOREIGN KEY (cuota_id)
        REFERENCES cuota (cuota_id),
    CONSTRAINT fk_envio_plantilla FOREIGN KEY (plantilla_id)
        REFERENCES plantilla_mensaje (plantilla_mensaje_id),
    CONSTRAINT chk_envio_estado
        CHECK (estado IN ('enviado', 'entregado', 'leido', 'fallido'))
);

-- ----------------------------------------------------------------------------
-- CONVERSACION_BOT (sesion/maquina de estados del bot)
--  ultima_interaccion: ventana de 24h de Meta + expiracion de sesion
-- ----------------------------------------------------------------------------
CREATE TABLE conversacion_bot
(
    conversacion_bot_id UUID        NOT NULL DEFAULT gen_random_uuid(),
    paciente_id         UUID        NOT NULL,
    telefono            VARCHAR(20) NOT NULL,
    estado_conversacion VARCHAR(30) NOT NULL DEFAULT 'inicio',
    ultima_interaccion  TIMESTAMPTZ NOT NULL DEFAULT now(),
    activa              BOOLEAN     NOT NULL DEFAULT TRUE,

    CONSTRAINT pk_conversacion PRIMARY KEY (conversacion_bot_id),
    CONSTRAINT fk_conv_paciente FOREIGN KEY (paciente_id)
        REFERENCES paciente (paciente_id),
    CONSTRAINT chk_conv_estado
        CHECK (estado_conversacion IN ('inicio', 'menu_principal',
                                       'consultando_deuda', 'consultando_cuotas',
                                       'esperando_comprobante'))
);

-- ----------------------------------------------------------------------------
-- MENSAJE_BOT (historial; contenido NULL cuando es media pura)
-- ----------------------------------------------------------------------------
CREATE TABLE mensaje_bot
(
    mensaje_bot_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
    conversacion_id  UUID        NOT NULL,
    direccion        VARCHAR(10) NOT NULL,
    tipo_mensaje     VARCHAR(20) NOT NULL DEFAULT 'texto',
    contenido        TEXT        NULL,   -- lo que lee un humano
    intent_detectado VARCHAR(50) NULL,   -- NULL si no se detecto intencion
    payload_raw      JSONB       NULL,   -- webhook crudo de Meta (debug)
    media_url        TEXT        NULL,   -- ruta en TU almacenamiento
    timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_mensaje PRIMARY KEY (mensaje_bot_id),
    CONSTRAINT fk_mensaje_conv FOREIGN KEY (conversacion_id)
        REFERENCES conversacion_bot (conversacion_bot_id),
    CONSTRAINT chk_mensaje_direccion
        CHECK (direccion IN ('entrante', 'saliente')),
    CONSTRAINT chk_mensaje_tipo
        CHECK (tipo_mensaje IN ('texto', 'imagen', 'audio', 'documento')),
    CONSTRAINT chk_mensaje_intent
        CHECK (intent_detectado IN ('consulta_deuda', 'consulta_proxima_cuota',
                                    'hablar_con_humano', 'envio_comprobante'))
);

-- ----------------------------------------------------------------------------
-- AUDITORIA (registro_id sin FK: es polimorfico, apunta a cualquier tabla)
-- ----------------------------------------------------------------------------
CREATE TABLE auditoria
(
    auditoria_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
    usuario_id       UUID        NULL,   -- NULL = accion del sistema (cron/jobs)
    accion           TEXT        NOT NULL,
    tabla_afectada   TEXT        NOT NULL,
    registro_id      UUID        NULL,
    datos_anteriores JSONB       NULL,
    datos_nuevos     JSONB       NULL,
    fecha            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_auditoria PRIMARY KEY (auditoria_id),
    CONSTRAINT fk_auditoria_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuario (usuario_id)
);

-- ----------------------------------------------------------------------------
-- INDICES sobre FKs muy consultadas
-- (PostgreSQL NO indexa FKs automaticamente; los UNIQUE ya traen indice)
-- ----------------------------------------------------------------------------
CREATE INDEX idx_cirugia_paciente   ON cirugia (paciente_id);
CREATE INDEX idx_cm_cirugia         ON cirugia_medica (cirugia_id);
CREATE INDEX idx_cm_medico          ON cirugia_medica (medico_id);
CREATE INDEX idx_cuota_plan         ON cuota (plan_pago_id);
CREATE INDEX idx_cuota_vencimiento  ON cuota (fecha_vencimiento, estado);  -- cron recordatorios
CREATE INDEX idx_pago_plan          ON pago (plan_pago_id);
CREATE INDEX idx_pago_cuota         ON pago (cuota_id);
CREATE INDEX idx_pago_oficina       ON pago (oficina_usuario_id);
CREATE INDEX idx_envio_paciente     ON envio_whatsapp (paciente_id);
CREATE INDEX idx_envio_cuota        ON envio_whatsapp (cuota_id);
CREATE INDEX idx_conv_paciente      ON conversacion_bot (paciente_id);
CREATE INDEX idx_mensaje_conv       ON mensaje_bot (conversacion_id);
CREATE INDEX idx_auditoria_usuario  ON auditoria (usuario_id);
CREATE INDEX idx_auditoria_fecha    ON auditoria (fecha);

-- ----------------------------------------------------------------------------
-- DATOS SEMILLA: metodos de pago
-- ----------------------------------------------------------------------------
INSERT INTO metodo_pago (metodo, descripcion) VALUES
    ('efectivo',      'Pago en ventanilla de la oficina'),
    ('transferencia', 'Transferencia bancaria'),
    ('QR',            'Pago por QR bancario'),
    ('tarjeta',       'Tarjeta de debito/credito');

COMMIT;
