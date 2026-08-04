# Propuesta Técnica: Lógica de Financiamiento y Amortización

## 1. Escenario Base: Pago en Cuotas (Crédito al 2% mensual)
Para el sistema de financiamiento, se recomienda implementar el Sistema de Amortización Francés (Cuota Fija). En este modelo, el paciente paga el mismo monto cada mes, lo cual es más fácil de explicar y de cobrar.

**Fórmula aplicada:** `Cuota = P * i / (1 - (1+i)^-n)`

Ejemplo para una cirugía de Bs 10.000 (P=10.000, i=2%, n=10): Cuota fija = Bs 1.113,27

| # Cuota | Monto Capital (Bs) | Monto Interés (Bs) | Monto Total (Bs) |
| :---: | :--- | :--- | :--- |
| **1** | 913,27 | 200,00 (2% de 10.000) | 1.113,27 |
| **2** | 931,54 | 181,73 (2% de 9.086,73) | 1.113,27 |
| **3** | 950,17 | 163,10 | 1.113,27 |

* Total que paga el paciente: Bs 11.132,65 (Interés ganado: Bs 1.132,65).
* La última cuota se ajusta por los centavos del redondeo.
* Por esta razón, la tabla de cuotas tiene `monto_capital` y `monto_interes` separados: el interés se calcula sobre el saldo insoluto (el capital que aún se debe), no sobre el monto original.

## 2. Escenario Adicional: Cuota Inicial (Anticipo)
Es una práctica muy común que las clínicas soliciten un adelanto antes de operar. Por ejemplo, en una cirugía de Bs 10.000, el paciente paga Bs 3.000 de inicial y financia los Bs 7.000 restantes.

**Ajustes sugeridos en Base de Datos:**
* **Tabla `planes_pago`:** Agregar los campos `cuota_inicial = 3.000`, `monto_financiado = 7.000`, `numero_cuotas = 10`. Las cuotas se calcularán sobre los 7.000 financiados.
* **Tabla `pagos`:** Registrar la inicial como un pago más. Se debe agregar el tipo a la enumeración de base de datos: `tipo: 'cuota_inicial' | 'pago_cuota' | 'amortizacion_capital'`.

## 3. Regla General de Amortización de Capital
Cuando un paciente realiza un pago extraordinario destinado a reducir su deuda principal, el sistema debe registrar el pago sin vincularlo a una cuota mensual específica. La regla de negocio es la siguiente:

* Si `pagos.tipo = 'amortizacion_capital'`, entonces el campo `cuota_id` debe ser `NULL`.
* El monto ingresado se descuenta de forma directa del `saldo_pendiente` del plan general (el capital vivo).
* Posterior a la transacción, es obligatorio desencadenar el recálculo de las cuotas pendientes.

## 4. Caso de Estudio Práctico (Amortización)
Tomando el plan original de Bs 10.000 a 10 cuotas fijas (Bs 1.113,27 c/u):

* **Estado Actual:** El paciente ya pagó las cuotas 1 y 2. Su saldo pendiente es de Bs 8.155,19.
* **Evento:** El paciente desea adelantar capital por un monto de Bs 3.000,00 extra.

**Paso 1: Inserción en la tabla de Pagos**

| id | plan_pago_id | cuota_id | tipo | monto (Bs) | metodo |
| :---: | :---: | :---: | :--- | :--- | :--- |
| **101** | 1 | 1 | pago_cuota | 1.113,27 | efectivo |
| **102** | 1 | 2 | pago_cuota | 1.113,27 | QR |
| **103** | 1 | NULL | amortizacion_capital | 3.000,00 | efectivo |

**Paso 2: Actualización del Plan de Pago**

El saldo del capital vivo se ajusta inmediatamente mediante la siguiente resta:
* `Nuevo Saldo = 8.155,19 - 3.000,00 = 5.155,19`

## 5. Opciones de Negocio para el Recálculo (Paso 3)
Con el nuevo saldo de Bs 5.155,19, el equipo debe definir cómo se comportarán las cuotas pendientes. Existen dos enfoques estándar:

### Opción A: Reducir la Cuota (Mantener el Plazo)
Se respeta la cantidad de meses que le faltan al paciente (8 meses restantes), pero se recalcula la cuota mensual para que sea más baja, dándole alivio económico mensual.
* **Fórmula:** Se recalcula con P = 5.155,19, i = 2%, n = 8.
* **Nuevo escenario:** El paciente seguirá pagando hasta la cuota 10, pero su pago mensual baja de Bs 1.113,27 a Bs 703,74.
* **Ventaja Comercial:** El paciente percibe un beneficio inmediato en su flujo de caja mensual. Es el modelo más predecible para la retención.

### Opción B: Reducir el Plazo (Mantener la Cuota)
El paciente sigue pagando exactamente lo mismo por mes, pero debido al adelanto de capital, terminará de pagar su deuda en menos meses.
* **Mecánica:** Las cuotas se mantienen en Bs 1.113,27. Al dividir el saldo restante (Bs 5.155,19), el plan alcanza solo para aproximadamente 4.6 cuotas más.
* **Nuevo escenario:** El paciente terminará de pagar unos 3 meses antes de lo previsto. La última cuota será una fracción menor para liquidar el saldo.
* **Ventaja Comercial:** La empresa recupera el total del capital invertido mucho más rápido y cierra la cuenta antes.

## 6. Siguientes Pasos y Definiciones Requeridas
* Aprobar qué opción de recálculo (A o B) será la regla por defecto en el sistema, o si se habilitará un selector en la interfaz para que el operador o paciente elija.
* Confirmar con el cliente la inclusión de la Cuota Inicial en el alcance actual, considerando que agregar los campos en base de datos en esta fase temprana evitará refactorizaciones y deuda técnica en el futuro.
