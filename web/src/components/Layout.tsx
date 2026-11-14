import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Layout() {
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  if (state.status !== 'authenticated') return null;

  return (
    <>
      <header className="topbar">
        <strong className="brand">HaluDec</strong>
        <nav aria-label="Main">
          <NavLink to="/datasets">Datasets</NavLink>
          <NavLink to="/experiments">Experiments</NavLink>
        </nav>
        <span className="spacer" />
        <span className="muted small">
          {state.session.user.email} · {state.session.organization.name}
        </span>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void logout().then(() => navigate('/login'));
          }}
        >
          Sign out
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
