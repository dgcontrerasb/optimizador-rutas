import React, { useState } from 'react';
import {
  Route,
  Navigation,
  User,
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  LockKeyhole,
  AlertCircle
} from 'lucide-react';
import {
  verifyCredentialsWithDetails,
  persistAuthenticatedSession,
  getLoginLockoutStatus,
  resetPasswordWithMasterKey,
  openWhatsAppRecovery
} from '../services/auth';

export type SplitCurtainState = 'closed' | 'opening';

interface LoginViewProps {
  onLoginSuccess: () => void;
  curtainState?: SplitCurtainState;
}

export const LoginView: React.FC<LoginViewProps> = ({
  onLoginSuccess,
  curtainState = 'closed'
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Modal de recuperación de contraseña
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryAccount, setRecoveryAccount] = useState<'jefe_cendis' | 'coordinador'>('jefe_cendis');
  const [recoveryTab, setRecoveryTab] = useState<'whatsapp' | 'master'>('whatsapp');
  const [masterKey, setMasterKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySuccess, setRecoverySuccess] = useState<string | null>(null);

  const isOpening = curtainState === 'opening';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const lockout = getLoginLockoutStatus();
    if (lockout.locked) {
      setErrorMsg(`Acceso bloqueado por seguridad. Espera ${lockout.remainingMinutes} minuto(s) antes de reintentar.`);
      return;
    }

    if (!username.trim() || !password.trim()) {
      setErrorMsg('Por favor ingresa tu usuario y contraseña operativa.');
      return;
    }

    setIsSubmitting(true);
    setTimeout(() => {
      const result = verifyCredentialsWithDetails(username, password);
      if (result.success) {
        persistAuthenticatedSession(rememberMe, result.user || 'Coordinador');
        setIsSubmitting(false);
        onLoginSuccess();
      } else {
        setIsSubmitting(false);
        setErrorMsg(result.error || 'Credenciales inválidas. Verifica tu usuario y contraseña de coordinador.');
      }
    }, 150);
  };

  const handleMasterResetSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError(null);
    setRecoverySuccess(null);

    if (newPassword !== confirmPassword) {
      setRecoveryError('Las contraseñas no coinciden.');
      return;
    }

    const res = resetPasswordWithMasterKey(recoveryAccount, masterKey, newPassword);
    if (res.success) {
      setRecoverySuccess('✅ Contraseña actualizada exitosamente. Ya puedes iniciar sesión con tu nueva clave.');
      setMasterKey('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        setShowRecoveryModal(false);
        setRecoverySuccess(null);
      }, 2000);
    } else {
      setRecoveryError(res.error || 'No se pudo restablecer la contraseña.');
    }
  };

  return (
    <div
      className={`min-h-screen w-full flex flex-col md:flex-row overflow-hidden font-sans select-none ${
        isOpening ? 'pointer-events-none bg-transparent' : 'bg-transparent'
      }`}
    >
      {/* PANEL IZQUIERDO (Hero / Visual Brand) - Compuerta Izquierda */}
      <div
        style={{
          transition: 'transform 1100ms cubic-bezier(0.16, 1, 0.3, 1), opacity 950ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
        className={`w-full md:w-1/2 lg:w-[55%] h-full min-h-[520px] md:min-h-screen relative flex flex-col justify-between p-8 lg:p-12 overflow-hidden shadow-2xl will-change-transform ${
          isOpening
            ? '-translate-y-full md:translate-y-0 md:-translate-x-full opacity-0'
            : 'translate-y-0 translate-x-0 opacity-100'
        }`}
      >
        {/* Imagen adjunta de referencia + fondo limpio del contenedor y camión Jamar */}
        <img
          src="/assets/aistudio/Gemini_Generated_Image_ref7nrref7nrref7_c1844cd6.jpg"
          alt="Referencia Jamar TMS"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover object-left opacity-0 pointer-events-none"
          aria-hidden="true"
        />
        <img
          src="/assets/jamar-truck-container.jpg"
          alt="Contenedor y Camión Jamar Cendis Siberia"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover object-[72%_center]"
        />

        {/* Overlay de contraste sutil para máxima legibilidad sin tapar ni oscurecer los muebles ni el contenedor */}
        <div
          className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/20 to-transparent pointer-events-none"
          style={{
            background:
              'linear-gradient(to right, rgba(15, 23, 42, 0.7) 0%, rgba(15, 23, 42, 0.2) 60%, transparent 100%)'
          }}
        />

        {/* Header superior */}
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/20 p-1.5 backdrop-blur-md flex items-center justify-center shadow-lg">
              <div className="w-full h-full rounded-xl bg-white flex items-center justify-center p-1">
                <img
                  src="/logo.png"
                  alt="Rutas Jamar"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              </div>
            </div>
            <div>
              <span className="block text-white font-bold text-lg leading-tight tracking-tight drop-shadow-xs">
                Rutas Jamar
              </span>
              <span className="block text-orange-400 font-medium text-xs leading-tight mt-0.5">
                TMS Flota &amp; Despacho
              </span>
            </div>
          </div>

          <div className="bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 text-xs px-3 py-1.5 rounded-full backdrop-blur-md inline-flex items-center gap-2 font-semibold tracking-wide shadow-sm">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
            <span>CENDIS SIBERIA • OPERACIÓN ACTIVA</span>
          </div>
        </div>

        {/* Bloque central de contenido */}
        <div className="relative z-10 my-auto py-8 max-w-md">
          <h1 className="text-white text-3xl sm:text-4xl lg:text-[42px] font-bold leading-[1.12] tracking-tight drop-shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
            Control inteligente
            <br />
            de despacho
            <br />
            y cubicaje elástico
          </h1>

          <p className="text-slate-200 text-sm leading-relaxed max-w-md mt-3 drop-shadow-[0_1px_4px_rgba(0,0,0,0.4)]">
            Optimización vial en tiempo real, consolidación de pedidos y ruteo OSRM para la Sabana de Occidente y Bogotá.
          </p>

          {/* Puntos clave minimalistas flotantes */}
          <div className="mt-8 space-y-5">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-orange-500/20 border border-orange-500/35 backdrop-blur-md flex items-center justify-center text-orange-400 shrink-0 shadow-sm">
                <Route className="w-6 h-6 text-orange-400" strokeWidth={1.8} />
              </div>
              <div className="pt-0.5">
                <h3 className="text-white font-bold text-sm sm:text-base leading-snug drop-shadow-xs">
                  Optimización de rutas
                </h3>
                <p className="text-slate-200 text-xs sm:text-sm leading-snug mt-0.5 max-w-[260px] drop-shadow-xs">
                  Planificación inteligente para entregas rápidas y eficientes.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-blue-500/20 border border-blue-500/35 backdrop-blur-md flex items-center justify-center text-blue-400 shrink-0 shadow-sm">
                <Navigation className="w-5 h-5 text-blue-400" strokeWidth={1.8} />
              </div>
              <div>
                <h3 className="text-white font-bold text-sm sm:text-base leading-snug drop-shadow-[0_1px_4px_rgba(0,0,0,0.5)]">
                  Trazado Vial
                </h3>
                <p className="text-white font-semibold text-xs sm:text-sm leading-snug mt-0.5 drop-shadow-[0_1px_6px_rgba(0,0,0,0.65)]">
                  OSRM Deep Links &amp; Geocodificación
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer inferior */}
        <div className="relative z-10 backdrop-blur-sm bg-black/30 border border-white/10 rounded-lg p-2.5 px-4 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 text-orange-400 shrink-0" />
            <span className="text-white/90 font-medium">
              Acceso restringido para coordinadores de transporte Jamar
            </span>
          </div>
          <span className="text-white/90 font-medium">Cendis Siberia TMS © 2026</span>
        </div>
      </div>

      {/* PANEL DERECHO (Formulario Clean de Acceso Operativo) - Compuerta Derecha */}
      <div
        style={{
          transition: 'transform 1100ms cubic-bezier(0.16, 1, 0.3, 1), opacity 950ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
        className={`w-full md:w-1/2 lg:w-[45%] bg-[#ffffff] text-slate-900 flex items-center justify-center p-8 lg:p-16 shadow-2xl will-change-transform select-text ${
          isOpening
            ? 'translate-y-full md:translate-y-0 md:translate-x-full opacity-0'
            : 'translate-y-0 translate-x-0 opacity-100'
        }`}
      >
        <div className="max-w-md w-full mx-auto space-y-6">
          {/* Encabezado */}
          <div>
            <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Iniciar Sesión</h2>
            <p className="text-sm text-slate-500 mt-1">
              Ingresa tus credenciales para acceder a la consola de despacho
            </p>
          </div>

          {/* Formulario */}
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {errorMsg && (
              <div className="flex items-center gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Campo 1: USUARIO O CÉDULA */}
            <div className="space-y-2">
              <label
                htmlFor="username"
                className="block uppercase text-xs font-semibold text-slate-700 tracking-wide"
              >
                USUARIO O CÉDULA
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  placeholder="ej. coordinador.siberia"
                  className="w-full pl-11 pr-4 py-3.5 rounded-xl border border-slate-200 bg-slate-50/50 text-slate-900 text-sm placeholder:text-slate-400 focus:bg-white focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 outline-none transition"
                />
              </div>
            </div>

            {/* Campo 2: CONTRASEÑA */}
            <div className="space-y-2">
              <label
                htmlFor="password"
                className="block uppercase text-xs font-semibold text-slate-700 tracking-wide"
              >
                CONTRASEÑA
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  placeholder="••••••••••••"
                  className="w-full pl-11 pr-11 py-3.5 rounded-xl border border-slate-200 bg-slate-50/50 text-slate-900 text-sm placeholder:text-slate-400 focus:bg-white focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 outline-none transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 transition cursor-pointer"
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Checkbox: Mantener sesión activa y Enlace de Recuperación */}
            <div className="flex items-center justify-between pt-0.5 flex-wrap gap-2">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-orange-600 accent-orange-600 focus:ring-orange-500 cursor-pointer"
                />
                <span className="text-xs sm:text-sm text-slate-700 font-medium">
                  Recordarme
                </span>
              </label>

              <button
                type="button"
                onClick={() => {
                  setShowRecoveryModal(true);
                  setRecoveryError(null);
                  setRecoverySuccess(null);
                }}
                className="text-xs font-semibold text-orange-600 hover:text-orange-700 transition cursor-pointer"
              >
                ¿Olvidaste tu contraseña?
              </button>
            </div>

            {/* Botón de acción */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full bg-orange-600 hover:bg-orange-700 active:scale-[0.99] disabled:opacity-70 text-white font-medium py-3.5 rounded-xl shadow-lg shadow-orange-500/25 flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <span>{isSubmitting ? 'Verificando acceso...' : 'Ingresar al Despacho'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          {/* Pie del formulario */}
          <div className="pt-2 flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <LockKeyhole className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Conexión cifrada de extremo a extremo · Cendis Siberia</span>
          </div>
        </div>
      </div>

      {/* MODAL DE RECUPERACIÓN DE CONTRASEÑA */}
      {showRecoveryModal && (
        <div className="fixed inset-0 z-[99999] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 select-none">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 sm:p-8 space-y-5 shadow-2xl border border-slate-100">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center font-bold">
                  🔐
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-slate-900">Recuperación de Acceso</h3>
                  <p className="text-[11px] text-slate-500">Cendis Siberia · Rutas Jamar</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowRecoveryModal(false)}
                className="w-8 h-8 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Selector de cuenta a recuperar */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Selecciona el usuario a recuperar:</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setRecoveryAccount('jefe_cendis')}
                  className={`py-2 px-3 rounded-xl text-xs font-bold transition border cursor-pointer ${
                    recoveryAccount === 'jefe_cendis'
                      ? 'bg-orange-50 border-orange-500 text-orange-700'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  👔 Jefe Cendis
                </button>
                <button
                  type="button"
                  onClick={() => setRecoveryAccount('coordinador')}
                  className={`py-2 px-3 rounded-xl text-xs font-bold transition border cursor-pointer ${
                    recoveryAccount === 'coordinador'
                      ? 'bg-orange-50 border-orange-500 text-orange-700'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  📋 Coordinador
                </button>
              </div>
            </div>

            {/* Pestañas de método de recuperación */}
            <div className="flex rounded-xl bg-slate-100 p-1 text-xs font-bold">
              <button
                type="button"
                onClick={() => setRecoveryTab('whatsapp')}
                className={`flex-1 py-1.5 rounded-lg transition cursor-pointer text-center ${
                  recoveryTab === 'whatsapp' ? 'bg-white shadow-xs text-orange-600' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                📱 Vía WhatsApp
              </button>
              <button
                type="button"
                onClick={() => setRecoveryTab('master')}
                className={`flex-1 py-1.5 rounded-lg transition cursor-pointer text-center ${
                  recoveryTab === 'master' ? 'bg-white shadow-xs text-orange-600' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                🔑 Clave Maestra
              </button>
            </div>

            {/* Método 1: WhatsApp */}
            {recoveryTab === 'whatsapp' && (
              <div className="space-y-3 pt-1">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Genera una solicitud oficial y envíala a la línea de soporte de Despacho para validar tu identidad y recibir tu clave:
                </p>
                <button
                  type="button"
                  onClick={() => openWhatsAppRecovery(recoveryAccount === 'jefe_cendis' ? 'Jefe Cendis' : 'Coordinador')}
                  className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-sm"
                >
                  <span>💬</span>
                  <span>Enviar solicitud por WhatsApp</span>
                </button>
              </div>
            )}

            {/* Método 2: Clave Maestra */}
            {recoveryTab === 'master' && (
              <form onSubmit={handleMasterResetSubmit} className="space-y-3 pt-1">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Si cuentas con autorización de la jefatura, introduce la <b>Clave Maestra de Seguridad</b> para asignar una nueva contraseña en este equipo:
                </p>

                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-slate-700">Clave Maestra:</label>
                  <input
                    type="password"
                    value={masterKey}
                    onChange={(e) => setMasterKey(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 focus:outline-none focus:border-orange-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-slate-700">Nueva Contraseña:</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Mínimo 6 caracteres"
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 focus:outline-none focus:border-orange-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-slate-700">Confirmar Nueva Contraseña:</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repite la nueva contraseña"
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-800 focus:outline-none focus:border-orange-500"
                  />
                </div>

                {recoveryError && (
                  <p className="text-xs text-rose-600 font-semibold">{recoveryError}</p>
                )}
                {recoverySuccess && (
                  <p className="text-xs text-emerald-600 font-bold">{recoverySuccess}</p>
                )}

                <button
                  type="submit"
                  className="w-full py-2.5 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs transition cursor-pointer"
                >
                  ✓ Restablecer Contraseña
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LoginView;
