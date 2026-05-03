import Logo from "../assets/squirrel.png";
import Close from "../assets/Close.svg";
import { Link, useLocation } from "react-router-dom";
import { Platform, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
const appWindow = getCurrentWebviewWindow();
const CloseButton = () => {
  return (
    <button
      onClick={() => {
        appWindow.close();
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-6 w-6"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
    </button>
  );
};
const TitleBar = () => {
  let { state, pathname } = useLocation() as any;
  const [plf, setPlf] = useState<Platform | undefined>();
  useEffect(() => {
    setPlf(platform());
  }, []);
  return (
    <div
      data-tauri-drag-region
      className="flex bg-darkBlue h-70 justify-between w-full items-center pl-3 pr-3 titlebar bg-cyan-800 p-2 text-white"
      style={{ background: "#0F1831" }}
    >
      {plf !== "macos" ? (
        <img src={Logo} className="h-6 w-6"></img>
      ) : (
        <CloseButton></CloseButton>
      )}
      <div className="font-bold">
        <nav className="flex navi" aria-label="Breadcrumb">
          <ol className="inline-flex items-center space-x-1 md:space-x-3">
            <li className="inline-flex items-center">
              <Link
                to="/"
                className="inline-flex items-center text-sm  cursor-pointer text-gray-400 hover:text-white"
              >
                SquirrelDisk
              </Link>
            </li>

            {pathname == "/disk" && (
              <li>
                <div className="flex items-center">
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <Link
                    to="/"
                    className="ml-1 text-sm font-medium cursor-pointer md:ml-2 text-gray-400 hover:text-white"
                  >
                    All Disks
                  </Link>
                </div>
              </li>
            )}
            {state && state.disk && (
              <li aria-current="page">
                <div className="flex items-center">
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="ml-1 text-sm font-medium md:ml-2 text-gray-500">
                    {state.isDirectory ? "Folder" : "Disk"} ({state.disk})
                  </span>
                </div>
              </li>
            )}
          </ol>
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <Link
          to="/settings"
          aria-label="Settings"
          className="text-gray-400 hover:text-white"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M19.14 12.94a7.92 7.92 0 0 0 .05-.94 7.92 7.92 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.78 7.78 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.78 7.78 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.92 7.92 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96a7.78 7.78 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.78 7.78 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z" />
          </svg>
        </Link>
        {plf !== "macos" ? (
          <CloseButton></CloseButton>
        ) : (
          <img src={Logo} className="h-6 w-6"></img>
        )}
      </div>
    </div>
  );
};

export default TitleBar;
