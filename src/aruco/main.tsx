// ArUco ステッカー検証ページ（aruco.html）の入口
import { render } from "preact";
import "../styles.css";
import "./aruco.css";
import { ArucoPage } from "./page";

render(<ArucoPage />, document.getElementById("app")!);
