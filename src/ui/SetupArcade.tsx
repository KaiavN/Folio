import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Animated,
	AppState,
	PanResponder,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	runImpactHaptic,
	runNotificationHaptic,
	runSelectionHaptic,
} from "./haptics.ts";
import { darkColors, useColors } from "./colors.tsx";

type ArcadeGame = "tic-tac-toe" | "pong";
type Mark = "X" | "O" | null;

const TTT_WIN_LINES = [
	[0, 1, 2],
	[3, 4, 5],
	[6, 7, 8],
	[0, 3, 6],
	[1, 4, 7],
	[2, 5, 8],
	[0, 4, 8],
	[2, 4, 6],
];

const BOT_MOVE_DELAY_MS = 420;

const PONG_WIDTH = 264;
const PONG_HEIGHT = 208;
const PADDLE_WIDTH = 74;
const PADDLE_HEIGHT = 10;
const BALL_SIZE = 12;
const PADDLE_MARGIN = 16;
const PONG_TICK_MS = 16;
const PONG_BASE_SPEED_X = 3.6;
const PONG_BASE_SPEED_Y = 4.9;
const PONG_SPEED_STEP = 0.42;
const PONG_MAX_SPEED_X = 8.4;
const PONG_MAX_SPEED_Y = 10.6;
const BOT_BASE_SPEED = 6.6;
const BOT_MAX_SPEED = 8.4;
const TOUCH_THUMB_WIDTH = 52;

type PongState = {
	ballX: number;
	ballY: number;
	velocityX: number;
	velocityY: number;
	playerPaddleX: number;
	botPaddleX: number;
	playerScore: number;
	botScore: number;
	rallyCount: number;
};

export function SetupArcade() {
	const COLORS = useColors();
	const styles = buildStyles(COLORS);
	const [activeGame, setActiveGame] = useState<ArcadeGame>("tic-tac-toe");
	const activeGameCopy =
		activeGame === "tic-tac-toe"
			? {
					title: "You always move first",
					body: "A quick, smart bot and one-tap controls make this the easiest way to kill a minute.",
				}
			: {
					title: "Slide the rail to steer",
					body: "The rally starts the moment you touch the control strip, and every clean return makes the ball faster.",
				};

	return (
		<View style={styles.shell}>
			<View style={styles.switcher}>
				{[
					{ id: "tic-tac-toe", label: "Tic-tac-toe" },
					{ id: "pong", label: "Pong" },
				].map((game) => {
					const isActive = activeGame === game.id;
					return (
						<Pressable
							key={game.id}
							onPress={() => {
								runImpactHaptic("light");
								setActiveGame(game.id as ArcadeGame);
							}}
							accessibilityRole="button"
							accessibilityState={{ selected: isActive }}
							accessibilityLabel={`${game.label} mini game`}
							style={({ pressed }) => [
								styles.switcherButton,
								isActive ? styles.switcherButtonActive : null,
								pressed ? styles.pressed : null,
							]}
						>
							<Text
								style={[
									styles.switcherText,
									isActive ? styles.switcherTextActive : null,
								]}
							>
								{game.label}
							</Text>
						</Pressable>
					);
				})}
			</View>

			<View style={styles.helperCard}>
				<Text style={styles.helperTitle}>{activeGameCopy.title}</Text>
				<Text style={styles.helperBody}>{activeGameCopy.body}</Text>
			</View>

			{activeGame === "tic-tac-toe" ? <TicTacToeGame styles={styles} /> : <PongGame styles={styles} />}
		</View>
	);
}

function TicTacToeGame({ styles }: { styles: ReturnType<typeof buildStyles> }) {
	const [board, setBoard] = useState<Mark[]>(Array(9).fill(null));
	const [playerWins, setPlayerWins] = useState(0);
	const [botWins, setBotWins] = useState(0);
	const [draws, setDraws] = useState(0);
	const [turn, setTurn] = useState<"player" | "bot">("player");
	const lastOutcomeRef = useRef<"X" | "O" | "draw" | null>(null);

	const outcome = useMemo(() => evaluateBoard(board), [board]);

	useEffect(() => {
		if (turn !== "bot" || outcome) {
			return;
		}

		const handle = setTimeout(() => {
			setBoard((currentBoard) => {
				const nextMove = chooseBotMove(currentBoard);
				if (nextMove < 0) {
					return currentBoard;
				}

				const nextBoard = [...currentBoard];
				nextBoard[nextMove] = "O";
				return nextBoard;
			});
			setTurn("player");
		}, BOT_MOVE_DELAY_MS);

		return () => clearTimeout(handle);
	}, [outcome, turn]);

	useEffect(() => {
		if (!outcome) {
			return;
		}

		if (lastOutcomeRef.current !== outcome) {
			if (outcome === "X") {
				runNotificationHaptic("success");
			} else if (outcome === "O") {
				runNotificationHaptic("warning");
			} else {
				runSelectionHaptic();
			}
			lastOutcomeRef.current = outcome;
		}

		if (outcome === "X") {
			setPlayerWins((current) => current + 1);
			return;
		}

		if (outcome === "O") {
			setBotWins((current) => current + 1);
			return;
		}

		setDraws((current) => current + 1);
	}, [outcome]);

	useEffect(() => {
		if (!outcome) {
			lastOutcomeRef.current = null;
			return;
		}

		const handle = setTimeout(() => {
			resetBoard();
		}, 1150);

		return () => clearTimeout(handle);
	}, [outcome]);

	function handleMove(index: number) {
		if (turn !== "player" || board[index] || outcome) {
			return;
		}

		runSelectionHaptic();
		const nextBoard = [...board];
		nextBoard[index] = "X";
		setBoard(nextBoard);
		setTurn("bot");
	}

	function resetBoard() {
		runSelectionHaptic();
		setBoard(Array(9).fill(null));
		setTurn("player");
	}

	const statusLabel = outcome
		? outcome === "draw"
			? "Draw. Resetting the board..."
			: outcome === "X"
				? "You won that round. Resetting..."
				: "The computer took it. Resetting..."
		: turn === "player"
			? "Your turn"
			: "Computer is thinking";

	return (
		<View style={styles.gameCard}>
			<View style={styles.gameHeader}>
				<Text style={styles.gameTitle}>Beat the bot</Text>
				<Text style={styles.gameSubtitle}>
					Classic 3x3 while setup finishes.
				</Text>
			</View>

			<View style={styles.scoreRow}>
				<ScoreChip label="You" value={playerWins} styles={styles} />
				<ScoreChip label="Bot" value={botWins} styles={styles} />
				<ScoreChip label="Draws" value={draws} styles={styles} />
			</View>

			<View style={styles.ticTacToeBoard}>
				{board.map((cell, index) => (
					<Pressable
						key={index}
						onPress={() => handleMove(index)}
						accessibilityRole="button"
						accessibilityLabel={`Tic-tac-toe cell ${index + 1}${cell ? `, occupied by ${cell}` : ""}`}
						accessibilityState={{
							disabled:
								turn !== "player" || Boolean(board[index]) || Boolean(outcome),
						}}
						style={({ pressed }) => [
							styles.ticTacToeCell,
							pressed ? styles.pressed : null,
							cell ? styles.ticTacToeCellFilled : null,
						]}
					>
						<View style={styles.ticTacToeCellInner}>
							<Text
								style={[
									styles.ticTacToeCellText,
									cell === "O" ? styles.ticTacToeCellTextMuted : null,
								]}
							>
								{cell ?? ""}
							</Text>
						</View>
					</Pressable>
				))}
			</View>

			<View style={styles.gameFooter}>
				<Text style={styles.gameStatus}>{statusLabel}</Text>
				<Pressable
					onPress={() => {
						runSelectionHaptic();
						resetBoard();
					}}
					accessibilityRole="button"
					accessibilityLabel="Reset tic-tac-toe board"
					style={({ pressed }) => [
						styles.resetButton,
						pressed ? styles.pressed : null,
					]}
				>
					<Text style={styles.resetButtonText}>New round</Text>
				</Pressable>
			</View>
		</View>
	);
}

function PongGame({ styles }: { styles: ReturnType<typeof buildStyles> }) {
	const [isRunning, setIsRunning] = useState(false);
	const [scores, setScores] = useState({
		playerScore: 0,
		botScore: 0,
		rallyCount: 0,
	});
	const gameStateRef = useRef<PongState>(createInitialPongState());
	const committedScoresRef = useRef({
		playerScore: 0,
		botScore: 0,
		rallyCount: 0,
	});

	// Visual positions live in Animated.Value refs — setValue() bypasses React reconciliation
	const ballXAnim = useRef(
		new Animated.Value(gameStateRef.current.ballX),
	).current;
	const ballYAnim = useRef(
		new Animated.Value(gameStateRef.current.ballY),
	).current;
	const playerPaddleXAnim = useRef(
		new Animated.Value(gameStateRef.current.playerPaddleX),
	).current;
	const botPaddleXAnim = useRef(
		new Animated.Value(gameStateRef.current.botPaddleX),
	).current;
	const thumbXAnim = useRef(
		playerPaddleXAnim.interpolate({
			inputRange: [0, PONG_WIDTH - PADDLE_WIDTH],
			outputRange: [
				Math.max(PADDLE_WIDTH / 2 - TOUCH_THUMB_WIDTH / 2, 0),
				Math.min(
					PONG_WIDTH - PADDLE_WIDTH + PADDLE_WIDTH / 2 - TOUCH_THUMB_WIDTH / 2,
					PONG_WIDTH - TOUCH_THUMB_WIDTH,
				),
			],
			extrapolate: "clamp",
		}),
	).current;

	const handleControlTouch = useCallback(
		(locationX: number) => {
			if (!isRunning && gameStateRef.current.rallyCount === 0) {
				runImpactHaptic("light");
			}
			setIsRunning(true);
			const nextPaddleX = clamp(
				locationX - PADDLE_WIDTH / 2,
				0,
				PONG_WIDTH - PADDLE_WIDTH,
			);
			gameStateRef.current = {
				...gameStateRef.current,
				playerPaddleX: nextPaddleX,
			};
			playerPaddleXAnim.setValue(nextPaddleX);
		},
		[isRunning, playerPaddleXAnim],
	);

	const panResponder = useMemo(
		() =>
			PanResponder.create({
				onStartShouldSetPanResponderCapture: () => true,
				onMoveShouldSetPanResponderCapture: () => true,
				onStartShouldSetPanResponder: () => true,
				onMoveShouldSetPanResponder: () => true,
				onPanResponderGrant: (event) =>
					handleControlTouch(event.nativeEvent.locationX),
				onPanResponderMove: (event) =>
					handleControlTouch(event.nativeEvent.locationX),
				onPanResponderTerminationRequest: () => false,
				onPanResponderRelease: () => undefined,
				onPanResponderTerminate: () => undefined,
			}),
		[handleControlTouch],
	);

	const previousRallyCountRef = useRef(0);
	const previousPlayerScoreRef = useRef(0);
	const previousBotScoreRef = useRef(0);

	useEffect(() => {
		if (!isRunning) {
			return;
		}

		let frameId = 0;
		let lastTickAt = 0;

		const tick = (timestamp: number) => {
			if (!lastTickAt || timestamp - lastTickAt >= PONG_TICK_MS) {
				lastTickAt = timestamp;
				const nextState = stepPong(gameStateRef.current);
				gameStateRef.current = nextState;

				// Direct setValue() — no React re-render, just shadow tree update
				ballXAnim.setValue(nextState.ballX);
				ballYAnim.setValue(nextState.ballY);
				playerPaddleXAnim.setValue(nextState.playerPaddleX);
				botPaddleXAnim.setValue(nextState.botPaddleX);

				const committed = committedScoresRef.current;
				if (
					nextState.playerScore !== committed.playerScore ||
					nextState.botScore !== committed.botScore ||
					nextState.rallyCount !== committed.rallyCount
				) {
					committedScoresRef.current = {
						playerScore: nextState.playerScore,
						botScore: nextState.botScore,
						rallyCount: nextState.rallyCount,
					};
					setScores({
						playerScore: nextState.playerScore,
						botScore: nextState.botScore,
						rallyCount: nextState.rallyCount,
					});
				}
			}
			frameId = requestAnimationFrame(tick);
		};

		frameId = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(frameId);
	}, [isRunning, ballXAnim, ballYAnim, playerPaddleXAnim, botPaddleXAnim]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (nextState) => {
			if (nextState !== "active") {
				setIsRunning(false);
			}
		});

		return () => subscription.remove();
	}, []);

	useEffect(() => {
		if (scores.playerScore > previousPlayerScoreRef.current) {
			runNotificationHaptic("success");
		} else if (scores.botScore > previousBotScoreRef.current) {
			runNotificationHaptic("warning");
		} else if (scores.rallyCount > previousRallyCountRef.current) {
			runSelectionHaptic();
		}

		previousRallyCountRef.current = scores.rallyCount;
		previousPlayerScoreRef.current = scores.playerScore;
		previousBotScoreRef.current = scores.botScore;
	}, [scores.botScore, scores.playerScore, scores.rallyCount]);

	function resetGame() {
		runSelectionHaptic();
		const initial = createInitialPongState();
		gameStateRef.current = initial;
		committedScoresRef.current = { playerScore: 0, botScore: 0, rallyCount: 0 };
		ballXAnim.setValue(initial.ballX);
		ballYAnim.setValue(initial.ballY);
		playerPaddleXAnim.setValue(initial.playerPaddleX);
		botPaddleXAnim.setValue(initial.botPaddleX);
		setIsRunning(false);
		setScores({ playerScore: 0, botScore: 0, rallyCount: 0 });
	}

	const primaryControlLabel =
		!isRunning && scores.rallyCount === 0
			? "Serve"
			: isRunning
				? "Pause"
				: "Resume";

	return (
		<View style={styles.gameCard}>
			<View style={styles.gameHeader}>
				<Text style={styles.gameTitle}>Mini pong</Text>
				<Text style={styles.gameSubtitle}>
					Slide the control rail. Each return adds pace, so rallies build
					naturally.
				</Text>
			</View>

			<View style={styles.scoreRow}>
				<ScoreChip label="You" value={scores.playerScore} styles={styles} />
				<ScoreChip label="Bot" value={scores.botScore} styles={styles} />
				<ScoreChip label="Rally" value={scores.rallyCount} styles={styles} />
			</View>

			<View
				style={styles.pongCourt}
				accessible
				accessibilityLabel="Pong court. Use the control rail below to move your paddle."
			>
				<Animated.View
					style={[
						styles.pongPaddle,
						styles.pongBotPaddle,
						{ left: botPaddleXAnim },
					]}
				/>
				<Animated.View
					style={[
						styles.pongPaddle,
						styles.pongPlayerPaddle,
						{ left: playerPaddleXAnim },
					]}
				/>
				<Animated.View
					style={[styles.pongBall, { left: ballXAnim, top: ballYAnim }]}
				/>
				<View style={styles.pongCenterLine} pointerEvents="none" />
			</View>

			<View
				style={styles.pongTouchRail}
				accessible
				accessibilityLabel="Pong control rail. Slide left or right to move your paddle."
				{...panResponder.panHandlers}
			>
				<Animated.View style={[styles.pongTouchThumb, { left: thumbXAnim }]} />
				<Text style={styles.pongTouchHint}>Slide to move your paddle</Text>
			</View>

			<View style={styles.gameControlRow}>
				<Pressable
					onPress={() => {
						runImpactHaptic("light");
						setIsRunning((current) => !current);
					}}
					accessibilityRole="button"
					accessibilityLabel={
						primaryControlLabel === "Serve"
							? "Serve pong"
							: `${primaryControlLabel} pong`
					}
					style={({ pressed }) => [
						styles.controlButton,
						styles.controlButtonPrimary,
						pressed ? styles.pressed : null,
					]}
				>
					<Text style={styles.controlButtonPrimaryText}>
						{primaryControlLabel}
					</Text>
				</Pressable>
				<Pressable
					onPress={resetGame}
					accessibilityRole="button"
					accessibilityLabel="Restart pong"
					style={({ pressed }) => [
						styles.controlButton,
						pressed ? styles.pressed : null,
					]}
				>
					<Text style={styles.resetButtonText}>Restart</Text>
				</Pressable>
			</View>

			<View style={styles.gameFooter}>
				<Text style={styles.gameStatus}>
					{isRunning
						? "Rally live. Returns add more pace as the game goes on."
						: scores.rallyCount === 0
							? "Touch the rail to serve. Each clean return adds more pace."
							: "Resume when you are ready to keep the rally alive."}
				</Text>
			</View>
		</View>
	);
}

function ScoreChip({ label, value, styles }: { label: string; value: number; styles: ReturnType<typeof buildStyles> }) {
	return (
		<View style={styles.scoreChip}>
			<Text style={styles.scoreChipLabel}>{label}</Text>
			<Text style={styles.scoreChipValue}>{value}</Text>
		</View>
	);
}

function chooseBotMove(board: Mark[]): number {
	const openMoves = board
		.map((cell, index) => (cell ? null : index))
		.filter((value): value is number => typeof value === "number");

	if (!openMoves.length) {
		return -1;
	}

	const winningMove = findLineMove(board, "O");
	if (winningMove >= 0) {
		return winningMove;
	}

	const blockingMove = findLineMove(board, "X");
	if (blockingMove >= 0) {
		return blockingMove;
	}

	if (!board[4]) {
		return 4;
	}

	const preferredMoves = [0, 2, 6, 8].filter((index) => !board[index]);
	const movePool = preferredMoves.length ? preferredMoves : openMoves;
	return movePool[Math.floor(Math.random() * movePool.length)];
}

function findLineMove(board: Mark[], mark: Exclude<Mark, null>): number {
	for (const line of TTT_WIN_LINES) {
		const values = line.map((index) => board[index]);
		const matches = values.filter((value) => value === mark).length;
		const empties = line.filter((index) => board[index] === null);
		if (matches === 2 && empties.length === 1) {
			return empties[0];
		}
	}

	return -1;
}

function evaluateBoard(board: Mark[]): "X" | "O" | "draw" | null {
	for (const [a, b, c] of TTT_WIN_LINES) {
		if (board[a] && board[a] === board[b] && board[a] === board[c]) {
			return board[a];
		}
	}

	return board.every(Boolean) ? "draw" : null;
}

function createInitialPongState(): PongState {
	return {
		ballX: PONG_WIDTH / 2 - BALL_SIZE / 2,
		ballY: PONG_HEIGHT / 2 - BALL_SIZE / 2,
		velocityX: Math.random() > 0.5 ? PONG_BASE_SPEED_X : -PONG_BASE_SPEED_X,
		velocityY: Math.random() > 0.5 ? PONG_BASE_SPEED_Y : -PONG_BASE_SPEED_Y,
		playerPaddleX: PONG_WIDTH / 2 - PADDLE_WIDTH / 2,
		botPaddleX: PONG_WIDTH / 2 - PADDLE_WIDTH / 2,
		playerScore: 0,
		botScore: 0,
		rallyCount: 0,
	};
}

function stepPong(state: PongState): PongState {
	const botTargetX = clamp(
		state.ballX - (PADDLE_WIDTH - BALL_SIZE) / 2,
		0,
		PONG_WIDTH - PADDLE_WIDTH,
	);
	const botDelta = botTargetX - state.botPaddleX;
	const botSpeed = resolveBotSpeed(state.rallyCount);
	const nextBotPaddleX =
		Math.abs(botDelta) < botSpeed
			? botTargetX
			: state.botPaddleX + Math.sign(botDelta) * botSpeed;

	let nextBallX = state.ballX + state.velocityX;
	let nextBallY = state.ballY + state.velocityY;
	let nextVelocityX = state.velocityX;
	let nextVelocityY = state.velocityY;
	let playerScore = state.playerScore;
	let botScore = state.botScore;
	let rallyCount = state.rallyCount;

	if (nextBallX <= 0 || nextBallX >= PONG_WIDTH - BALL_SIZE) {
		nextVelocityX *= -1;
		nextBallX = clamp(nextBallX, 0, PONG_WIDTH - BALL_SIZE);
	}

	const botPaddleTop = PADDLE_MARGIN;
	const botPaddleBottom = botPaddleTop + PADDLE_HEIGHT;
	if (
		nextVelocityY < 0 &&
		nextBallY <= botPaddleBottom &&
		nextBallX + BALL_SIZE >= nextBotPaddleX &&
		nextBallX <= nextBotPaddleX + PADDLE_WIDTH
	) {
		rallyCount += 1;
		nextBallY = botPaddleBottom;
		nextVelocityY = accelerateVerticalSpeed(Math.abs(nextVelocityY));
		nextVelocityX = scaleDeflection(nextBallX, nextBotPaddleX, rallyCount);
	}

	const playerPaddleTop = PONG_HEIGHT - PADDLE_MARGIN - PADDLE_HEIGHT;
	if (
		nextVelocityY > 0 &&
		nextBallY + BALL_SIZE >= playerPaddleTop &&
		nextBallX + BALL_SIZE >= state.playerPaddleX &&
		nextBallX <= state.playerPaddleX + PADDLE_WIDTH
	) {
		rallyCount += 1;
		nextBallY = playerPaddleTop - BALL_SIZE;
		nextVelocityY = -accelerateVerticalSpeed(Math.abs(nextVelocityY));
		nextVelocityX = scaleDeflection(nextBallX, state.playerPaddleX, rallyCount);
	}

	if (nextBallY < -BALL_SIZE) {
		playerScore += 1;
		return {
			...createInitialPongState(),
			playerScore,
			botScore,
		};
	}

	if (nextBallY > PONG_HEIGHT) {
		botScore += 1;
		return {
			...createInitialPongState(),
			playerScore,
			botScore,
		};
	}

	return {
		...state,
		ballX: nextBallX,
		ballY: nextBallY,
		velocityX: nextVelocityX,
		velocityY: nextVelocityY,
		botPaddleX: nextBotPaddleX,
		playerScore,
		botScore,
		rallyCount,
	};
}

function calculateDeflection(ballX: number, paddleX: number): number {
	const paddleCenter = paddleX + PADDLE_WIDTH / 2;
	const ballCenter = ballX + BALL_SIZE / 2;
	const offset = (ballCenter - paddleCenter) / (PADDLE_WIDTH / 2);
	return clamp(offset * 3.8, -4.6, 4.6);
}

function accelerateVerticalSpeed(speed: number): number {
	return Math.min(speed + PONG_SPEED_STEP, PONG_MAX_SPEED_Y);
}

function scaleDeflection(
	ballX: number,
	paddleX: number,
	rallyCount: number,
): number {
	const baseDeflection = calculateDeflection(ballX, paddleX);
	const scaledDeflection =
		baseDeflection * Math.min(1 + rallyCount * 0.035, 1.45);
	return clamp(scaledDeflection, -PONG_MAX_SPEED_X, PONG_MAX_SPEED_X);
}

function resolvePongSpeed(state: PongState): number {
	return Math.max(Math.abs(state.velocityX), Math.abs(state.velocityY));
}

function resolveBotSpeed(rallyCount: number): number {
	return Math.min(BOT_BASE_SPEED + rallyCount * 0.18, BOT_MAX_SPEED);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function buildStyles(COLORS: typeof darkColors) {
	return StyleSheet.create({
		shell: {
			gap: 14,
		},
		switcher: {
			flexDirection: "row",
			gap: 8,
			padding: 4,
			backgroundColor: COLORS.bgSubtle,
			borderRadius: 18,
			borderWidth: 1,
			borderColor: COLORS.border,
		},
		helperCard: {
			gap: 4,
			paddingHorizontal: 14,
			paddingVertical: 12,
			borderRadius: 18,
			backgroundColor: COLORS.bgSubtle,
			borderWidth: 1,
		borderColor: COLORS.border,
	},
	helperTitle: {
		color: COLORS.textPrimary,
		fontSize: 13,
		fontWeight: "800",
	},
	helperBody: {
		color: COLORS.textSecondary,
		fontSize: 12,
		lineHeight: 17,
	},
	switcherButton: {
		flex: 1,
		minHeight: 44,
		paddingVertical: 12,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 14,
	},
	switcherButtonActive: {
		backgroundColor: COLORS.accentPrimary,
	},
	switcherText: {
		color: COLORS.textSecondary,
		fontSize: 13,
		fontWeight: "700",
	},
	switcherTextActive: {
		color: COLORS.accentOnDark,
	},
	gameCard: {
		gap: 14,
		backgroundColor: COLORS.bgCard,
		borderRadius: 24,
		borderWidth: 1,
		borderColor: COLORS.borderMed,
		padding: 16,
	},
	gameHeader: {
		gap: 4,
	},
	gameTitle: {
		color: COLORS.textPrimary,
		fontSize: 18,
		fontWeight: "800",
	},
	gameSubtitle: {
		color: COLORS.textSecondary,
		fontSize: 13,
		lineHeight: 18,
	},
	scoreRow: {
		flexDirection: "row",
		gap: 10,
	},
	scoreChip: {
		flex: 1,
		gap: 4,
		padding: 12,
		borderRadius: 18,
		backgroundColor: COLORS.bgSubtleMid,
	},
	scoreChipLabel: {
		color: COLORS.textTertiary,
		fontSize: 11,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 0.8,
	},
	scoreChipValue: {
		color: COLORS.textPrimary,
		fontSize: 18,
		fontWeight: "800",
	},
	ticTacToeBoard: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 10,
	},
	ticTacToeCell: {
		width: "31%",
		aspectRatio: 1,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 20,
		backgroundColor: COLORS.bgSubtle,
		borderWidth: 1,
		borderColor: COLORS.border,
	},
	ticTacToeCellFilled: {
		backgroundColor: COLORS.bgSubtleMid,
	},
	ticTacToeCellInner: {
		width: "100%",
		alignItems: "center",
		justifyContent: "center",
	},
	ticTacToeCellText: {
		color: COLORS.accentPrimary,
		fontSize: 28,
		lineHeight: 30,
		fontWeight: "800",
		textAlign: "center",
		includeFontPadding: false,
		transform: [{ translateY: -1 }],
	},
	ticTacToeCellTextMuted: {
		color: COLORS.accentLime,
	},
	pongCourt: {
		width: "100%",
		maxWidth: PONG_WIDTH,
		height: PONG_HEIGHT,
		alignSelf: "center",
		borderRadius: 24,
		backgroundColor: COLORS.bgDeep,
		borderWidth: 1,
		borderColor: COLORS.border,
		overflow: "hidden",
		position: "relative",
	},
	pongCenterLine: {
		position: "absolute",
		left: "50%",
		marginLeft: -1,
		top: 0,
		bottom: 0,
		width: 2,
		backgroundColor: COLORS.borderMed,
	},
	pongPaddle: {
		position: "absolute",
		width: PADDLE_WIDTH,
		height: PADDLE_HEIGHT,
		borderRadius: 999,
	},
	pongBotPaddle: {
		top: PADDLE_MARGIN,
		backgroundColor: COLORS.accentLime,
	},
	pongPlayerPaddle: {
		top: PONG_HEIGHT - PADDLE_MARGIN - PADDLE_HEIGHT,
		backgroundColor: COLORS.accentPrimary,
	},
	pongBall: {
		position: "absolute",
		width: BALL_SIZE,
		height: BALL_SIZE,
		borderRadius: 999,
		backgroundColor: COLORS.textPrimary,
	},
	gameFooter: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
	},
	gameControlRow: {
		flexDirection: "row",
		gap: 10,
	},
	pongTouchRail: {
		width: "100%",
		maxWidth: PONG_WIDTH,
		alignSelf: "center",
		height: 54,
		borderRadius: 999,
		backgroundColor: COLORS.bgSubtleMid,
		borderWidth: 1,
		borderColor: COLORS.border,
		justifyContent: "center",
		overflow: "hidden",
		position: "relative",
	},
	pongTouchThumb: {
		position: "absolute",
		top: 5,
		bottom: 5,
		width: TOUCH_THUMB_WIDTH,
		borderRadius: 999,
		backgroundColor: COLORS.borderMed,
		borderWidth: 1,
		borderColor: COLORS.border,
	},
	pongTouchHint: {
		color: COLORS.textPrimary,
		fontSize: 13,
		fontWeight: "700",
		textAlign: "center",
	},
	gameStatus: {
		flex: 1,
		color: COLORS.textSecondary,
		fontSize: 13,
		lineHeight: 18,
	},
	controlButton: {
		flex: 1,
		minHeight: 44,
		paddingHorizontal: 14,
		paddingVertical: 12,
		borderRadius: 16,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: COLORS.bgSubtle,
	},
	controlButtonPrimary: {
		backgroundColor: COLORS.accentPrimary,
	},
	controlButtonPrimaryText: {
		color: COLORS.accentOnDark,
		fontSize: 13,
		fontWeight: "800",
	},
	resetButton: {
		minHeight: 44,
		paddingHorizontal: 14,
		paddingVertical: 12,
		borderRadius: 999,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: COLORS.bgSubtle,
	},
	resetButtonText: {
		color: COLORS.textPrimary,
		fontSize: 13,
		fontWeight: "700",
	},
	pressed: {
		opacity: 0.85,
	},
});
}
