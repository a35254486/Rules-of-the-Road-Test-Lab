/**
 * Rules of the Road Practice Assessment Engine
 * Department of War (DoW) Mission Support - IL5 Optimizations
 */

// Core state containers
let activeAssessmentPool = [];
let currentQuestionIndex = 0;
let userSelectedAnswers = []; // Holds selected option texts
let isImmediateFeedbackEnabled = false;
let isTimedModeActive = false;
let countdownTimerInterval = null;
let secondsRemainingInTimer = 3600;

// Bucket parameters
const bucketWeightings = {
    1: 0.06, // General (Rules 1-3)
    2: 0.16, // Steering & Sailing (Rules 4-10)
    3: 0.16, // Steering & Sailing (Rules 11-18)
    4: 0.06, // Steering & Sailing (Rule 19)
    5: 0.28, // Lights and Shapes (Rules 20-31)
    6: 0.28  // Sound and Light Signals (Rules 32-37)
};

/**
 * Formats sloppy raw rule tag strings into human-readable text.
 * Converts "Ror inland" -> "Inland", "Ror international" -> "International",
 * and "Ror [#][suffix]" -> "Rule [#][suffix]" (e.g. "Ror 35g" -> "Rule 35g").
 * Re-joins them cleanly with commas and spaces.
 */
function formatRuleTags(rawTagString) {
    if (!rawTagString) return "General COLREGS Rules";
    
    // Split the raw string by commas or semicolons
    let tokens = rawTagString.split(/[,;]+/).map(t => t.trim()).filter(t => t.length > 0);
    
    // Fallback: if there are no commas but multiple "ror" mentions, split on word boundaries
    if (tokens.length === 1 && (rawTagString.toLowerCase().match(/ror/g) || []).length > 1) {
        tokens = rawTagString.split(/(?=ror)/i).map(t => t.trim()).filter(t => t.length > 0);
    }
    
    const formattedTokens = tokens.map(token => {
        // 1. "Ror inland" -> "Inland" (case-insensitive)
        if (/ror\s+inland/i.test(token)) {
            return "Inland";
        }
        // 2. "Ror international" -> "International" (case-insensitive)
        if (/ror\s+international/i.test(token)) {
            return "International";
        }
        // 3. "Ror [start]-[end]" -> "Rules [start]-[end]" (supports sub-rules like 20a-20c)
        const rangeMatch = token.match(/ror\s*(\d+[a-z]*)-(\d+[a-z]*)/i);
        if (rangeMatch) {
            return `Rules ${rangeMatch[1]}-${rangeMatch[2]}`;
        }
        // 4. "Ror [#][suffix]" -> "Rule [#][suffix]" (supports sub-rules like 35g, 35h)
        const ruleMatch = token.match(/ror\s*(\d+[a-z]*)/i);
        if (ruleMatch) {
            return `Rule ${ruleMatch[1]}`;
        }
        
        return token;
    });
    
    // Join all formatted segments back together with a clean comma and space
    return formattedTokens.join(", ");
}

const categoryNames = {
    1: "Part A - General",
    2: "Part B - Steering & Sailing (Conduct of Vessels in Any Condition of Visibility)",
    3: "Part B - Steering & Sailing (Conduct of Vessels in Sight of One Another)",
    4: "Part B - Steering & Sailing (Conduct of Vessels in Restricted Visibility)",
    5: "Part C - Lights and Shapes",
    6: "Part D - Sound and Light Signals"
};

/**
 * Parses numeric rule designations from question data.
 * Safely evaluates individual numbers, hyphenated ranges (e.g. 20-31), and formatting quirks.
 */
function extractRuleTags(question) {
    const rawTagString = question["RULE TAGS"];
    if (!rawTagString) return [];
    
    const parsedRules = new Set();
    const sanitisedString = rawTagString.replace(/\s+/g, '');
    
    // Evaluate ranges: e.g. 20-31
    const rangeEvaluator = /(\d+)-(\d+)/g;
    let rangeMatch;
    while ((rangeMatch = rangeEvaluator.exec(sanitisedString)) !== null) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end; i++) {
            parsedRules.add(i);
        }
    }
    
    // Capture individual rules
    const numberEvaluator = /\d+/g;
    let numberMatch;
    while ((numberMatch = numberEvaluator.exec(sanitisedString)) !== null) {
        parsedRules.add(parseInt(numberMatch[0], 10));
    }
    
    return Array.from(parsedRules);
}

/**
 * Maps parsed rules to the correct category buckets (1-6).
 * Support multi-bucket overlap tagging.
 */
function identifyQuestionBuckets(question) {
    const rules = extractRuleTags(question);
    if (rules.length === 0) return [];
    
    const buckets = new Set();
    rules.forEach(rule => {
        if (rule >= 1 && rule <= 3) buckets.add(1);
        if (rule >= 4 && rule <= 10) buckets.add(2);
        if (rule >= 11 && rule <= 18) buckets.add(3);
        if (rule === 19) buckets.add(4);
        if (rule >= 20 && rule <= 31) buckets.add(5);
        if (rule >= 32 && rule <= 37) buckets.add(6);
    });
    return Array.from(buckets);
}

/**
 * Implements Proportional Scaling and Guaranteed Representation algorithm
 */
function assembleProportionalQuiz(targetSize, chosenBuckets) {
    // 1. Group the question bank by matching category buckets
    const bucketPools = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    
    questionBank.forEach((question, originalIndex) => {
        const itemCopy = { ...question, indexRef: originalIndex };
        const associatedBuckets = identifyQuestionBuckets(itemCopy);
        associatedBuckets.forEach(b => {
            if (bucketPools[b]) {
                bucketPools[b].push(itemCopy);
            }
        });
    });
    // 2. Filter down to selected active buckets
    const activeBucketKeys = Object.keys(chosenBuckets).map(Number).filter(k => chosenBuckets[k]);
    if (activeBucketKeys.length === 0) return [];
    // Calculate sum of active weights
    let sumActiveWeights = 0;
    activeBucketKeys.forEach(k => { sumActiveWeights += bucketWeightings[k]; });
    // 3. Scale and distribute quotas using Math.round
    const finalQuotas = {};
    let runningTotalAllocated = 0;
    activeBucketKeys.forEach(k => {
        const proportionalPercentage = bucketWeightings[k] / sumActiveWeights;
        let bucketQuota = Math.round(targetSize * proportionalPercentage);
        
        // Guaranteed representation safety
        if (bucketQuota < 1) {
            bucketQuota = 1;
        }
        finalQuotas[k] = bucketQuota;
        runningTotalAllocated += bucketQuota;
    });
    // 4. Adjust quota math conflicts to fit exact size
    let attempts = 0;
    while (runningTotalAllocated !== targetSize && attempts < 100) {
        attempts++;
        if (runningTotalAllocated > targetSize) {
            // Find active bucket with score count > 1 and reduce
            const reduceKeys = activeBucketKeys.filter(k => finalQuotas[k] > 1);
            if (reduceKeys.length === 0) break;
            reduceKeys.sort((a, b) => finalQuotas[b] - finalQuotas[a]); // Sort descending to cut from largest
            finalQuotas[reduceKeys[0]]--;
            runningTotalAllocated--;
        } else {
            // Add quota back to largest active buckets
            const increaseKeys = [...activeBucketKeys].sort((a, b) => finalQuotas[b] - finalQuotas[a]);
            finalQuotas[increaseKeys[0]]++;
            runningTotalAllocated++;
        }
    }
    // 5. Select random unique questions per bucket
    const selectedQuestionMap = new Map(); // Keep globally unique
    const selectedAssessmentPool = [];
    activeBucketKeys.forEach(k => {
        const currentPool = shuffleArray([...bucketPools[k]]);
        const quota = finalQuotas[k];
        let chosenFromBucket = 0;
        for (let i = 0; i < currentPool.length; i++) {
            if (chosenFromBucket >= quota) break;
            const q = currentPool[i];
            
            if (!selectedQuestionMap.has(q.indexRef)) {
                selectedQuestionMap.set(q.indexRef, q);
                selectedAssessmentPool.push({ ...q, chosenUnderBucket: k });
                chosenFromBucket++;
            }
        }
        // Fallback: If pool ran dry of unique questions, duplicate from pool as safeguard
        if (chosenFromBucket < quota) {
            for (let i = 0; i < currentPool.length; i++) {
                if (chosenFromBucket >= quota) break;
                const q = currentPool[i];
                selectedAssessmentPool.push({ ...q, chosenUnderBucket: k });
                chosenFromBucket++;
            }
        }
    });
   
    // --- Console Validation Audit ---
    const auditData = {};
    activeBucketKeys.forEach(k => {
        const actualCount = selectedAssessmentPool.filter(q => q.chosenUnderBucket === k).length;
        auditData[`Bucket ${k} (${categoryNames[k].substring(0, 15)}...)`] = {
            "Assigned Quota": finalQuotas[k],
            "Actual Deployed": actualCount,
            "Status": finalQuotas[k] === actualCount ? "✅ MATCH" : "⚠️ MISMATCH"
        };
    });
    console.log(`%c[Quota Validator] Target Test Size: ${targetSize}`, "color: #E8B00F; font-weight: bold; font-size: 13px;");
    console.table(auditData);
    // Final shuffle so category order isn't sequential
    return shuffleArray(selectedAssessmentPool);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * Initializes and transitions dashboard to active testing phase
 */
function initiateAssessment() {
    if (typeof questionBank === 'undefined' || !Array.isArray(questionBank) || questionBank.length === 0) {
        document.getElementById("missing-db-alert").classList.remove("hidden");
        return;
    }
    const sizeSlider = document.getElementById("quiz-size-slider");
    const immediateFeedbackCheckbox = document.getElementById("immediate-feedback-checkbox");
    const timedModeCheckbox = document.getElementById("timed-mode-checkbox");
    
    isTimedModeActive = timedModeCheckbox.checked;
    isImmediateFeedbackEnabled = isTimedModeActive ? false : immediateFeedbackCheckbox.checked;
    let targetSize = parseInt(sizeSlider.value, 10);
    const chosenBuckets = {};
    
    const checkboxes = document.querySelectorAll(".bucket-toggle-checkbox");
    checkboxes.forEach(chk => {
        const bNum = parseInt(chk.getAttribute("data-bucket"), 10);
        chosenBuckets[bNum] = chk.checked;
    });
    if (isTimedModeActive) {
        targetSize = 50;
        // Forces all buckets on for timed simulation
        for (let b = 1; b <= 6; b++) chosenBuckets[b] = true;
    }
    activeAssessmentPool = assembleProportionalQuiz(targetSize, chosenBuckets);
    if (activeAssessmentPool.length === 0) {
        alert("Configuration Error: Active configuration produced empty pool. Activate at least one category bucket.");
        return;
    }
    // Reset state
    currentQuestionIndex = 0;
    userSelectedAnswers = new Array(activeAssessmentPool.length).fill(null);
    
    // UI Screen adjustments
    document.getElementById("view-dashboard").classList.add("hidden");
    document.getElementById("view-testing").classList.remove("hidden");
    document.getElementById("view-results").classList.add("hidden");
    if (isTimedModeActive) {
        document.getElementById("timer-badge").classList.remove("hidden");
        triggerCountdown();
    } else {
        document.getElementById("timer-badge").classList.add("hidden");
        clearInterval(countdownTimerInterval);
    }
    loadActiveQuestion();
    renderNavigatorSidebar();
}

/**
 * Updates the progress bar based on the number of answered questions,
 * rather than the current question index.
 */
function updateProgressIndicators() {
    const totalQuestions = activeAssessmentPool.length;
    // Count how many questions have actually been answered
    const answeredCount = userSelectedAnswers.filter(ans => ans !== null).length;
    
    // Keep the text showing the current viewing position
    document.getElementById("progress-numerical").innerText = `Question ${currentQuestionIndex + 1} of ${totalQuestions}`;
    
    // Fill the bar based on the percentage of questions answered
    const fillPercent = (answeredCount / totalQuestions) * 100;
    document.getElementById("progress-bar-fill").style.width = `${fillPercent}%`;
}

/* Question card rendering engine */
function loadActiveQuestion() {
    const question = activeAssessmentPool[currentQuestionIndex];
    
    // Track indicators
    updateProgressIndicators();
    // Render Question Text
    document.getElementById("question-text-card").innerText = question["QUESTION TEXT"];
    // --- DYNAMIC DIAGRAM RESOLUTION ---
    const imgElement = document.getElementById("quiz-diagram");
    if (imgElement) {
        // Matches "DIAGRAM <number>" or "DIAGRAM [<number>]"
        const match = question["QUESTION TEXT"].match(/DIAGRAM\s*\[?(\d+)\]?/i);
        if (match) {
            const diagramNum = match[1];
            const normalizedKey = `DIAGRAM ${diagramNum}`; // e.g. "DIAGRAM 1"
            
            // Check if diagramData from diagrams.js exists and has this image
            if (typeof diagramData !== 'undefined' && diagramData[normalizedKey]) {
                imgElement.src = diagramData[normalizedKey];
                imgElement.style.display = "block"; // Show image
            } else {
                console.warn(`Could not find diagram data for "${normalizedKey}"`);
                imgElement.style.display = "none";
                imgElement.src = "";
            }
        } else {
            // Hide image completely if no diagram is mentioned in this question
            imgElement.style.display = "none";
            imgElement.src = "";
        }
    }
    // ----------------------------------
    // Options mapping
    const optionsContainer = document.getElementById("options-list");
    optionsContainer.innerHTML = "";
    const keySchema = [
        { textKey: "ANSWER 1", pointsKey: "POINTS" },
        { textKey: "ANSWER 2", pointsKey: "POINTS.1" },
        { textKey: "ANSWER 3", pointsKey: "POINTS.2" },
        { textKey: "ANSWER 4", pointsKey: "POINTS.3" }
    ];
    // Find correct answer
    let correctText = "";
    keySchema.forEach(opt => {
        if (question[opt.pointsKey] === 100) {
            correctText = question[opt.textKey];
        }
    });
    const alreadyAnswered = userSelectedAnswers[currentQuestionIndex] !== null;
    const selectedAnswerText = userSelectedAnswers[currentQuestionIndex];
    keySchema.forEach(opt => {
        const optionText = question[opt.textKey];
        if (optionText && optionText.trim() !== "") {
            const btn = document.createElement("button");
            btn.className = "option-button";
            btn.innerText = optionText;
            // Handle UI states for historical feedback/selections
            if (alreadyAnswered) {
                btn.disabled = true;
                if (isImmediateFeedbackEnabled) {
                    if (optionText === correctText) {
                        btn.classList.add("correct");
                    } else if (optionText === selectedAnswerText) {
                        btn.classList.add("wrong");
                    }
                } else {
                    if (optionText === selectedAnswerText) {
                        btn.classList.add("selected");
                    }
                }
            } else {
                btn.onclick = () => selectOption(btn, optionText, correctText);
            }
            optionsContainer.appendChild(btn);
        }
    });
    // Show/Hide Explanation for Immediate Feedback Practice
    const explanationDiv = document.getElementById("explanation-box");
    const explanationText = document.getElementById("explanation-text");
    
    if (isImmediateFeedbackEnabled && alreadyAnswered) {
        explanationDiv.classList.remove("hidden");
        
        // Formats and cleans up the "Ror" designations cleanly
        const ruleTags = question["RULE TAGS"] ? `Rule(s) Applied: ${formatRuleTags(question["RULE TAGS"])}` : "General COLREGS Rules";
        const explanationBody = question["EXPLANATION"] || `Correct answer is: ${correctText}`;
        
        explanationText.innerHTML = `
            <div style="color: var(--navy-yellow); font-weight: bold; margin-bottom: 8px;">${ruleTags}</div>
            <div style="color: var(--navy-grey); font-size: 14px; line-height: 1.5;">${explanationBody}</div>
        `;
    } else {
        explanationDiv.classList.add("hidden");
    }
    // Nav Footer adjustments
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    if (currentQuestionIndex === 0) {
        prevBtn.classList.add("hidden");
    } else {
        prevBtn.classList.remove("hidden");
    }
    if (currentQuestionIndex === activeAssessmentPool.length - 1) {
        nextBtn.innerText = isImmediateFeedbackEnabled || alreadyAnswered || !isImmediateFeedbackEnabled ? "Submit Assessment 🎖️" : "Next Question ▶";
    } else {
        nextBtn.innerText = "Next ▶";
    }
    // Navigation is always allowed
    nextBtn.disabled = false;
    if (alreadyAnswered) {
        nextBtn.classList.add("btn-highlighted");
    } else {
        nextBtn.classList.remove("btn-highlighted");
    }
}

/**
 * Option selected event handler
 */
function selectOption(button, optionText, correctText) {
    userSelectedAnswers[currentQuestionIndex] = optionText;
    const alreadyAnswered = true;
    const optionsContainer = document.getElementById("options-list");
    const buttons = optionsContainer.getElementsByClassName("option-button");
    if (isImmediateFeedbackEnabled) {
        // Freeze and color immediately
        for (let btn of buttons) {
            btn.disabled = true;
            if (btn.innerText === correctText) {
                btn.classList.add("correct");
            } else if (btn === button && optionText !== correctText) {
                btn.classList.add("wrong");
            }
        }
        
        // Show explanation
        const question = activeAssessmentPool[currentQuestionIndex];
        const explanationDiv = document.getElementById("explanation-box");
        const explanationText = document.getElementById("explanation-text");
        explanationDiv.classList.remove("hidden");
        
        // Formats and cleans up the "Ror" designations cleanly
        const ruleTags = question["RULE TAGS"] ? `Rule(s) Applied: ${formatRuleTags(question["RULE TAGS"])}` : "General COLREGS Rules";
        const explanationBody = question["EXPLANATION"] || ``;
        
        explanationText.innerHTML = `
            <div style="color: var(--navy-yellow); font-weight: bold; margin-bottom: 8px;">${ruleTags}</div>
            <div style="color: var(--navy-grey); font-size: 14px; line-height: 1.5;">${explanationBody}</div>
        `;
        document.getElementById("next-btn").disabled = false;
    } else {
        // Standard mode: highlight selection without showing correctness
        for (let btn of buttons) {
            btn.classList.remove("selected");
        }
        button.classList.add("selected");
    }
    renderNavigatorSidebar();
    
    // UPDATE PROGRESS BAR IMMEDIATELY UPON SELECTION
    updateProgressIndicators();
}

/**
 * Sidebar Navigation Generator
 */
function renderNavigatorSidebar() {
    const grid = document.getElementById("question-grid-container");
    grid.innerHTML = "";
    activeAssessmentPool.forEach((q, idx) => {
        const btn = document.createElement("button");
        btn.className = "q-grid-btn";
        btn.innerText = idx + 1;
        if (idx === currentQuestionIndex) {
            btn.classList.add("current");
        } else if (userSelectedAnswers[idx] !== null) {
            btn.classList.add("answered");
            
            // Visual helper if in immediate feedback mode
            if (isImmediateFeedbackEnabled) {
                const correctText = getCorrectAnswerText(q);
                if (userSelectedAnswers[idx] === correctText) {
                    btn.classList.add("correct-fb");
                } else {
                    btn.classList.add("wrong-fb");
                }
            }
        }
        btn.onclick = () => jumpToQuestionIndex(idx);
        grid.appendChild(btn);
    });
}

function getCorrectAnswerText(q) {
    const keySchema = [
        { textKey: "ANSWER 1", pointsKey: "POINTS" },
        { textKey: "ANSWER 2", pointsKey: "POINTS.1" },
        { textKey: "ANSWER 3", pointsKey: "POINTS.2" },
        { textKey: "ANSWER 4", pointsKey: "POINTS.3" }
    ];
    let correct = "";
    keySchema.forEach(opt => {
        if (q[opt.pointsKey] === 100) correct = q[opt.textKey];
    });
    return correct;
}

function jumpToQuestionIndex(idx) {
    // Restriction check removed to allow completely free navigation via the sidebar
    currentQuestionIndex = idx;
    loadActiveQuestion();
    renderNavigatorSidebar();
}

function stepPrevious() {
    if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        loadActiveQuestion();
        renderNavigatorSidebar();
    }
}

function stepNext() {
    // Restriction check removed to allow skipping questions using the Next button
    if (currentQuestionIndex < activeAssessmentPool.length - 1) {
        currentQuestionIndex++;
        loadActiveQuestion();
        renderNavigatorSidebar();
    } else {
        submitCompletedAssessment();
    }
}

/**
 * Timer implementation for simulated examination
 */
function triggerCountdown() {
    clearInterval(countdownTimerInterval);
    secondsRemainingInTimer = 3600; // 60 mins
    renderTimer();
    
    countdownTimerInterval = setInterval(() => {
        secondsRemainingInTimer--;
        renderTimer();
        if (secondsRemainingInTimer <= 0) {
            clearInterval(countdownTimerInterval);
            alert("⏰ Timer Expired! Your assessment is submitting automatically.");
            submitCompletedAssessment();
        }
    }, 1000);
}

function renderTimer() {
    const mins = Math.floor(secondsRemainingInTimer / 60);
    const secs = secondsRemainingInTimer % 60;
    const timerBadge = document.getElementById("timer-badge");
    if (timerBadge) {
        timerBadge.innerText = `⏱️ Timer: ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

/**
 * Score computation and dashboard metrics saving
 */
function submitCompletedAssessment() {
    clearInterval(countdownTimerInterval);
    // Compute Grading
    let overallCorrect = 0;
    const bucketScores = {
        1: { correct: 0, total: 0, rules: {} },
        2: { correct: 0, total: 0, rules: {} },
        3: { correct: 0, total: 0, rules: {} },
        4: { correct: 0, total: 0, rules: {} },
        5: { correct: 0, total: 0, rules: {} },
        6: { correct: 0, total: 0, rules: {} }
    };
    activeAssessmentPool.forEach((q, idx) => {
        const userChoice = userSelectedAnswers[idx];
        const correctText = getCorrectAnswerText(q);
        const isCorrect = (userChoice === correctText);
        if (isCorrect) {
            overallCorrect++;
        }
        const bucketsAssociated = identifyQuestionBuckets(q);
        const rulesAssociated = extractRuleTags(q);
        bucketsAssociated.forEach(b => {
            bucketScores[b].total++;
            if (isCorrect) bucketScores[b].correct++;
            rulesAssociated.forEach(r => {
                if (verifyRuleInBucket(r, b)) {
                    if (!bucketScores[b].rules[r]) {
                        bucketScores[b].rules[r] = { correct: 0, total: 0 };
                    }
                    bucketScores[b].rules[r].total++;
                    if (isCorrect) bucketScores[b].rules[r].correct++;
                }
            });
        });
    });
    const scorePercentage = Math.round((overallCorrect / activeAssessmentPool.length) * 100);
    const hasPassed = (scorePercentage >= 90); // 90% strict passing criteria
    // Render results view elements
    document.getElementById("view-testing").classList.add("hidden");
    document.getElementById("view-results").classList.remove("hidden");
    // Circular progress SVG logic
    document.getElementById("score-percent-text").innerText = `${scorePercentage}%`;
    document.getElementById("score-numerical-summary").innerText = `Correct answers: ${overallCorrect} / ${activeAssessmentPool.length}`;
    
    const ringFill = document.getElementById("score-ring-fill");
    if (ringFill) {
        const radius = ringFill.r.baseVal.value;
        const circumference = radius * 2 * Math.PI;
        ringFill.style.strokeDasharray = `${circumference} ${circumference}`;
        const offset = circumference - (scorePercentage / 100) * circumference;
        ringFill.style.strokeDashoffset = offset;
    }
    const badge = document.getElementById("score-pass-fail-badge");
    if (hasPassed) {
        badge.innerText = "PASS";
        badge.className = "status-badge status-pass";
    } else {
        badge.innerText = "FAIL";
        badge.className = "status-badge status-fail";
    }
    renderCollapsibleResultsTable(bucketScores);
    // Save history data
    savePerformanceHistory(overallCorrect, activeAssessmentPool.length, hasPassed, bucketScores);
}

function verifyRuleInBucket(r, b) {
    if (b === 1) return r >= 1 && r <= 3;
    if (b === 2) return r >= 4 && r <= 10;
    if (b === 3) return r >= 11 && r <= 18;
    if (b === 4) return r === 19;
    if (b === 5) return r >= 20 && r <= 31;
    if (b === 6) return r >= 32 && r <= 37;
    return false;
}

function getBucketRulesDisplayRange(b) {
    if (b === 1) return "1-3";
    if (b === 2) return "4-10";
    if (b === 3) return "11-18";
    if (b === 4) return "19";
    if (b === 5) return "20-31";
    if (b === 6) return "32-37";
    return "";
}

/**
 * Renders expandable results performance breakdown
 */
function renderCollapsibleResultsTable(bucketScores) {
    const tbody = document.getElementById("bucket-breakdown-body");
    tbody.innerHTML = "";
    for (let b = 1; b <= 6; b++) {
        const data = bucketScores[b];
        const countTested = data.total;
        const percent = countTested > 0 ? Math.round((data.correct / countTested) * 100) : 0;
        
        let catColor = 'var(--navy-grey)';
        if (countTested > 0) {
            if (percent >= 90) catColor = '#48bb78';
            else if (percent >= 80) catColor = '#ecc94b';
            else catColor = '#e53e3e';
        }
        const rowHeader = document.createElement("tr");
        rowHeader.className = "collapsible-header";
        rowHeader.onclick = () => toggleDetailsRow(`rule-breakdown-${b}`, `icon-b-${b}`);
        rowHeader.innerHTML = `
            <td>
                <span id="icon-b-${b}" class="collapse-icon">▶</span>
                <strong>${categoryNames[b]}</strong>
            </td>
            <td>Rules ${getBucketRulesDisplayRange(b)}</td>
            <td>${countTested > 0 ? `${data.correct} / ${countTested}` : '0 / 0'}</td>
            <td><strong style="color: ${catColor}">${countTested > 0 ? `${percent}%` : '-'}</strong></td>
        `;
        tbody.appendChild(rowHeader);
        // Nested breakdown
        const rowDetails = document.createElement("tr");
        rowDetails.id = `rule-breakdown-${b}`;
        rowDetails.className = "rule-details-row hidden";
        let nestedHtml = "";
        const rulesTested = Object.keys(data.rules).map(Number).sort((a, b) => a - b);
        
        if (rulesTested.length > 0) {
            rulesTested.forEach(r => {
                const rCorrect = data.rules[r].correct;
                const rTotal = data.rules[r].total;
                const rPercent = Math.round((rCorrect / rTotal) * 100);
                
                let rColor = '#e53e3e';
                if (rPercent >= 90) rColor = '#48bb78';
                else if (rPercent >= 80) rColor = '#ecc94b';
                nestedHtml += `
                    <div class="rule-detail-item">
                        <span>Rule ${r}</span>
                        <span style="font-weight: bold; color: ${rColor}">${rCorrect} / ${rTotal} (${rPercent}%)</span>
                    </div>
                `;
            });
        } else {
            nestedHtml = `<div style="color: var(--navy-grey); font-size:12px;">No specific rules under this category were assessed.</div>`;
        }
        rowDetails.innerHTML = `
            <td colspan="4">
                <div class="rule-details-container">
                    <h4 style="margin: 0 0 6px 0; font-size: 13px; color: var(--navy-yellow);">Tested Rules Breakdown</h4>
                    ${nestedHtml}
                </div>
            </td>
        `;
        tbody.appendChild(rowDetails);
    }
}

function toggleDetailsRow(rowId, iconId) {
    const row = document.getElementById(rowId);
    const icon = document.getElementById(iconId);
    if (row && icon) {
        row.classList.toggle("hidden");
        icon.classList.toggle("open");
    }
}

/**
 * Data persistence engine using local storage
 */
function savePerformanceHistory(correctCount, totalCount, hasPassed, bucketScores) {
    const historicalEntries = JSON.parse(localStorage.getItem('dow_quiz_attempts') || '[]');
    
    const formattedBucketMetrics = {};
    for (let b = 1; b <= 6; b++) {
        if (bucketScores[b] && bucketScores[b].total > 0) {
            formattedBucketMetrics[`Bucket ${b}`] = {
                correct: bucketScores[b].correct,
                total: bucketScores[b].total
            };
        }
    }
    // Capture rule metrics per performance attempt
    const formattedRuleMetrics = {};
    for (let b = 1; b <= 6; b++) {
        if (bucketScores[b] && bucketScores[b].rules) {
            Object.keys(bucketScores[b].rules).forEach(r => {
                const ruleNum = parseInt(r, 10);
                formattedRuleMetrics[ruleNum] = {
                    correct: bucketScores[b].rules[r].correct,
                    total: bucketScores[b].rules[r].total
                };
            });
        }
    }
    // Capture precise question IDs that were deployed in this session
    const deployedQuestionRefs = activeAssessmentPool.map(q => q.indexRef);
    const currentEntry = {
        date: new Date().toISOString(),
        totalScore: correctCount,
        size: totalCount,
        passed: hasPassed,
        bucketScores: formattedBucketMetrics,
        ruleScores: formattedRuleMetrics, // Persist precise rule indexes
        deployedQuestions: deployedQuestionRefs // Tracks question IDs for analytics
    };
    historicalEntries.push(currentEntry);
    localStorage.setItem('dow_quiz_attempts', JSON.stringify(historicalEntries));
    renderHistoryDashboardTable();
}

function renderHistoryDashboardTable() {
    const tbody = document.getElementById("history-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    const entries = JSON.parse(localStorage.getItem('dow_quiz_attempts') || '[]');
    if (entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--navy-grey); padding: 20px;">No historical attempts found. Begin training by using the Assessment Creation panel.</td></tr>`;
        renderHistoricalRuleBreakdown(entries);
        return;
    }
    // Sort showing newest entries first
    const sorted = [...entries].reverse();
    sorted.forEach(entry => {
        const entryDate = new Date(entry.date);
        const formattedDate = entryDate.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }) + " EST";
        const percent = Math.round((entry.totalScore / entry.size) * 100);
        const badgeStyle = entry.passed ? "badge-pass" : "badge-fail";
        const badgeLabel = entry.passed ? "PASS" : "FAIL";
        // Category Badge loop
        let metricsBadges = "";
        for (let b = 1; b <= 6; b++) {
            const bucketData = entry.bucketScores && entry.bucketScores[`Bucket ${b}`];
            if (bucketData) {
                const bPercent = Math.round((bucketData.correct / bucketData.total) * 100);
                const passClass = bPercent >= 90 ? "badge-bucket-pass" : "badge-bucket-fail";
                metricsBadges += `<span class="badge badge-bucket ${passClass}">B${b}: ${bucketData.correct}/${bucketData.total}</span> `;
            }
        }
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${formattedDate}</strong></td>
            <td>${entry.size} Questions</td>
            <td>
                <span class="badge ${badgeStyle}">${badgeLabel}</span>
                <strong style="margin-left: 8px;">${entry.totalScore} / ${entry.size} (${percent}%)</strong>
            </td>
            <td>
                <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${metricsBadges || '<span style="color:var(--navy-grey)">-</span>'}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
    // Populate Rule-Based performance metrics breakdown
    renderHistoricalRuleBreakdown(entries);
}

/**
 * Compiles and appends cumulative historical breakdown of Rule-based performance
 */
function renderHistoricalRuleBreakdown(entries) {
    const tbody = document.getElementById("history-table-body");
    if (!tbody) return;
    const table = tbody.closest('table');
    if (!table) return;
    injectHistoryRuleStyles();
    let container = document.getElementById("history-rule-breakdown-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "history-rule-breakdown-container";
        container.className = "history-rule-section";
        table.parentNode.insertBefore(container, table.nextSibling);
    }
    if (entries.length === 0) {
        container.innerHTML = "";
        container.style.display = "none";
        return;
    }
    container.style.display = "block";
    // Initialize metrics container for rules 1-37
    const cumulativeRules = {};
    for (let r = 1; r <= 37; r++) {
        cumulativeRules[r] = { correct: 0, total: 0 };
    }
    // Traverse all attempts to calculate rules cumulative stats
    entries.forEach(entry => {
        if (entry.ruleScores) {
            Object.keys(entry.ruleScores).forEach(r => {
                const ruleNum = parseInt(r, 10);
                if (cumulativeRules[ruleNum]) {
                    cumulativeRules[ruleNum].correct += entry.ruleScores[r].correct;
                    cumulativeRules[ruleNum].total += entry.ruleScores[r].total;
                }
            });
        }
    });
    const hasAnyRuleData = Object.values(cumulativeRules).some(r => r.total > 0);
    container.innerHTML = `
        <div class="history-rule-header">
            <h3 class="history-rule-title">📊 Performance by Rule</h3>
            <div class="history-rule-filters" id="rule-filters-container">
                <button class="rule-filter-btn active" data-filter="all">All</button>
                <button class="rule-filter-btn" data-filter="mastered">High (≥90%)</button>
                <button class="rule-filter-btn" data-filter="warning">Medium (80-89%)</button>
                <button class="rule-filter-btn" data-filter="weak">Low (<80%)</button>
                <button class="rule-filter-btn" data-filter="untested">Untested</button>
            </div>
        </div>
        ${!hasAnyRuleData ? `
            <div style="text-align: center; color: var(--navy-grey); font-size: 13px; padding: 16px; background: rgba(255,255,255,0.02); border-radius: 6px;">
                📝 Rule-specific mastery breakdown will show up here after completing your first assessment.
            </div>
        ` : `
            <div class="history-rule-grid" id="history-rule-grid-items"></div>
        `}
    `;
    if (!hasAnyRuleData) return;
    const gridContainer = document.getElementById("history-rule-grid-items");
    const filterButtons = container.querySelectorAll(".rule-filter-btn");
    let activeFilter = "all";
    function drawGrid() {
        gridContainer.innerHTML = "";
        for (let r = 1; r <= 37; r++) {
            const data = cumulativeRules[r];
            const total = data.total;
            const correct = data.correct;
            const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
            let status = "untested";
            if (total > 0) {
                if (percent >= 90) {
                    status = "mastered";
                } else if (percent >= 80) {
                    status = "warning";
                } else {
                    status = "weak";
                }
            }
            // Filter checks
            if (activeFilter === "mastered" && status !== "mastered") continue;
            if (activeFilter === "warning" && status !== "warning") continue;
            if (activeFilter === "weak" && status !== "weak") continue;
            if (activeFilter === "untested" && status !== "untested") continue;
            const item = document.createElement("div");
            item.className = `rule-grid-item rule-status-${status}`;
            let scoreStr = "—";
            let percentStr = "";
            if (total > 0) {
                scoreStr = `${correct}/${total}`;
                percentStr = `<div class="rule-grid-percent">${percent}%</div>`;
            }
            item.innerHTML = `
                <div class="rule-grid-number">Rule ${r}</div>
                <div class="rule-grid-score">${scoreStr}</div>
                ${percentStr}
            `;
            gridContainer.appendChild(item);
        }
        if (gridContainer.children.length === 0) {
            gridContainer.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--navy-grey); padding: 24px; font-size: 13px;">No rules match the active filter.</div>`;
        }
    }
    filterButtons.forEach(btn => {
        btn.onclick = () => {
            filterButtons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeFilter = btn.getAttribute("data-filter");
            drawGrid();
        };
    });
    drawGrid();
}

/**
 * Programmatically inject styling rules for the Rule Breakdown interface block
 */
function injectHistoryRuleStyles() {
    if (document.getElementById("history-rule-styles")) return;
    const style = document.createElement("style");
    style.id = "history-rule-styles";
    style.textContent = `
        .history-rule-section {
            margin-top: 24px;
            padding-top: 24px;
            border-top: 2px dashed rgba(255, 255, 255, 0.1);
        }
        .history-rule-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            flex-wrap: wrap;
            gap: 12px;
        }
        .history-rule-title {
            font-size: 18px;
            font-weight: 700;
            color: #ffffff;
            margin: 0;
        }
        .history-rule-filters {
            display: flex;
            gap: 6px;
        }
        .rule-filter-btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #a0aec0;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        .rule-filter-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        .rule-filter-btn.active {
            background: var(--navy-yellow, #f6e05e);
            color: #1a202c;
            border-color: var(--navy-yellow, #f6e05e);
            font-weight: 600;
        }
        .history-rule-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(75px, 1fr));
            gap: 8px;
        }
        .rule-grid-item {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 6px;
            padding: 8px 4px;
            text-align: center;
            transition: transform 0.2s ease, background-color 0.2s ease;
        }
        .rule-grid-item:hover {
            transform: translateY(-1px);
            background: rgba(255, 255, 255, 0.05);
        }
        .rule-grid-number {
            font-size: 10px;
            color: #a0aec0;
            margin-bottom: 3px;
            font-weight: 500;
        }
        .rule-grid-score {
            font-size: 12px;
            font-weight: bold;
        }
        .rule-grid-percent {
            font-size: 10px;
            margin-top: 2px;
            opacity: 0.85;
        }
        .rule-status-mastered {
            border-left: 3px solid #48bb78;
            background: rgba(72, 187, 120, 0.04);
        }
        .rule-status-mastered .rule-grid-score {
            color: #48bb78;
        }
        .rule-status-warning {
            border-left: 3px solid #ecc94b;
            background: rgba(236, 201, 75, 0.04);
        }
        .rule-status-warning .rule-grid-score {
            color: #ecc94b;
        }
        .rule-status-weak {
            border-left: 3px solid #e53e3e;
            background: rgba(229, 62, 62, 0.04);
        }
        .rule-status-weak .rule-grid-score {
            color: #e53e3e;
        }
        .rule-status-untested {
            border-left: 3px solid #718096;
        }
        .rule-status-untested .rule-grid-score {
            color: #718096;
        }
    `;
    document.head.appendChild(style);
}

function clearSavedAttempts() {
    if (confirm("Are you sure you want to clear your testing history? This cannot be undone.")) {
        localStorage.removeItem('dow_quiz_attempts');
        renderHistoryDashboardTable();
    }
}

/**
 * Lifecycle and workflow handlers
 */
/**
 * Safely exits the active assessment. If questions were answered, 
 * it shrinks the test to match only the completed questions and submits it
 * as an official attempt.
 */
function exitToDashboard() {
    // 1. Find the exact indices of the questions the user actually answered
    const answeredIndices = [];
    userSelectedAnswers.forEach((ans, idx) => {
        if (ans !== null) {
            answeredIndices.push(idx);
        }
    });
    const answeredCount = answeredIndices.length;
    // 2. If they haven't answered anything at all, just exit normally without saving
    if (answeredCount === 0) {
        clearInterval(countdownTimerInterval);
        backToDashboard();
        return;
    }
    // 3. Confirm they want to submit the partial test
    const confirmExit = confirm(`You have answered ${answeredCount} question(s).\n\nAre you sure you want to exit and save this partial assessment to your history?`);
    if (!confirmExit) {
        return; // Abort exit, keep them on the current question
    }
    // 4. Create new arrays containing ONLY the answered questions
    const partialPool = [];
    const partialAnswers = [];
    
    answeredIndices.forEach(idx => {
        partialPool.push(activeAssessmentPool[idx]);
        partialAnswers.push(userSelectedAnswers[idx]);
    });
    // 5. Overwrite the active state with the new partial data
    activeAssessmentPool = partialPool;
    userSelectedAnswers = partialAnswers;
    // 6. Push to the standard submission engine to grade, save, and show results
    submitCompletedAssessment();
}

function backToDashboard() {
    document.getElementById("view-dashboard").classList.remove("hidden");
    document.getElementById("view-testing").classList.add("hidden");
    document.getElementById("view-results").classList.add("hidden");
    renderHistoryDashboardTable();
}

function reRunSameConfig() {
    initiateAssessment();
}

// Startup configurations
window.onload = function() {
    renderHistoryDashboardTable();
    
    // Dynamic sliders listener
    const sizeSlider = document.getElementById("quiz-size-slider");
    const sliderVal = document.getElementById("slider-value");
    sizeSlider.addEventListener("input", function() {
        sliderVal.innerText = this.value;
    });
    // Checkbox toggles logic (Synced for both card clicks and switch clicks)
    const toggles = document.querySelectorAll(".bucket-toggle");
    toggles.forEach(toggle => {
        const checkbox = toggle.querySelector(".bucket-toggle-checkbox");
        
        // 1. Listen for changes directly on the checkbox
        checkbox.addEventListener("change", function() {
            if (this.checked) {
                toggle.classList.add("active");
            } else {
                toggle.classList.remove("active");
            }
        });
        // 2. Listen for clicks on the card itself
        toggle.addEventListener("click", function(e) {
            // If the user clicked the toggle switch elements directly, let the native browser event handle it
            if (e.target.closest(".switch")) {
                return;
            }
            
            // Otherwise, if they clicked the card background/text, programmatically toggle the state
            if (!checkbox.disabled) {
                checkbox.checked = !checkbox.checked;
                // Trigger the 'change' event manually to run our styling logic above
                checkbox.dispatchEvent(new Event('change'));
            }
        });
    });
    // Setup exclusive timed mode lockings
    const timedCheckbox = document.getElementById("timed-mode-checkbox");
    const feedbackCheckbox = document.getElementById("immediate-feedback-checkbox");
    
    timedCheckbox.addEventListener("change", function() {
        if (this.checked) {
            sizeSlider.value = 50;
            sliderVal.innerText = "50";
            sizeSlider.disabled = true;
            feedbackCheckbox.checked = false;
            feedbackCheckbox.disabled = true;
            document.querySelectorAll(".bucket-toggle-checkbox").forEach(chk => {
                chk.checked = true;
                chk.disabled = true;
                chk.closest(".bucket-toggle").classList.add("active");
            });
        } else {
            sizeSlider.disabled = false;
            feedbackCheckbox.disabled = false;
            document.querySelectorAll(".bucket-toggle-checkbox").forEach(chk => {
                chk.disabled = false;
            });
        }
    });
    if (typeof questionBank === 'undefined') {
        document.getElementById("missing-db-alert").classList.remove("hidden");
    }
};

// ===================================================
// --- FEEDBACK POPUP INPUT MASH DETECTOR CONTROL ---
// ===================================================
let recentInputs = [];
const MASH_TIME_WINDOW_MS = 2000;    // 2-second tracking window
const MASH_INPUT_THRESHOLD = 10;     // 10 key presses or clicks to trigger

function handleMashInput(type) {
    const popup = document.getElementById("feedback-popup");
    
    // Only track inputs when the feedback pop-up is currently closed
    if (popup && popup.classList.contains("hidden")) {
        const now = Date.now();
        recentInputs.push(now);
        
        // Clean up inputs older than our 2-second sliding window
        recentInputs = recentInputs.filter(timestamp => now - timestamp < MASH_TIME_WINDOW_MS);
        
        console.log(`[Mash Detector] Input registered (${type}). Count in window: ${recentInputs.length}/${MASH_INPUT_THRESHOLD}`);
        
        // Trigger if threshold is crossed
        if (recentInputs.length >= MASH_INPUT_THRESHOLD) {
            console.log("[Mash Detector] Threshold reached! Triggering feedback modal.");
            recentInputs = []; // Flush tracking history
            showFeedbackModal();
        }
    }
}

// Track physical keyboard button mashing
window.addEventListener('keydown', () => {
    handleMashInput('Keyboard');
});

// Track rapid mouse/touchpad clicks on-screen
window.addEventListener('click', () => {
    handleMashInput('Mouse Click');
});

function showFeedbackModal() {
    const popup = document.getElementById("feedback-popup");
    if (popup) {
        popup.classList.remove("hidden");
    }
}

function closeFeedbackModal() {
    const popup = document.getElementById("feedback-popup");
    if (popup) {
        popup.classList.add("hidden");
    }
}

// ===================================================
// --- ADMIN QUESTION DEPLOYMENT REPORT CONTROLLER ---
// ===================================================
let adminKeyBuffer = "";

// Listen for sequential typing of the word "admin"
window.addEventListener('keydown', (event) => {
    // Only capture standard single character keys (a-z)
    if (event.key && event.key.length === 1) {
        adminKeyBuffer += event.key.toLowerCase();
        
        // Keep the buffer strictly limited to the last 5 characters typed
        if (adminKeyBuffer.length > 5) {
            adminKeyBuffer = adminKeyBuffer.slice(-5);
        }
        
        // If the exact sequence matches "admin", toggle the display
        if (adminKeyBuffer === "admin") {
            adminKeyBuffer = ""; // Reset buffer immediately on trigger
            
            // Safety: Don't trigger if the user is actively typing in a form input field
            const activeEl = document.activeElement.tagName;
            if (activeEl !== 'INPUT' && activeEl !== 'TEXTAREA') {
                toggleAdminReport();
            }
        }
    }
});

function toggleAdminReport() {
    const adminCard = document.getElementById("admin-report-card");
    if (adminCard) {
        const isHidden = adminCard.classList.toggle("hidden");
        if (!isHidden) {
            generateAdminDeploymentReport();
            // Scroll down to the report card smoothly
            adminCard.scrollIntoView({ behavior: 'smooth' });
        }
    }
}

function generateAdminDeploymentReport() {
    const tbody = document.getElementById("admin-report-body");
    if (!tbody || typeof questionBank === 'undefined') return;
    
    tbody.innerHTML = "";
    const entries = JSON.parse(localStorage.getItem('dow_quiz_attempts') || '[]');
    
    // Count frequency of deployed questions
    const deploymentCounts = {};
    // Seed all database questions with 0 counts
    questionBank.forEach((_, idx) => {
        deploymentCounts[idx] = 0;
    });
    
    // Populate with historical usage
    entries.forEach(entry => {
        if (entry.deployedQuestions && Array.isArray(entry.deployedQuestions)) {
            entry.deployedQuestions.forEach(qIdx => {
                if (deploymentCounts[qIdx] !== undefined) {
                    deploymentCounts[qIdx]++;
                }
            });
        }
    });
    
    // Map tracking to readable rows
    const reportData = questionBank.map((q, idx) => {
        const bucketIds = identifyQuestionBuckets(q);
        const bucketLabels = bucketIds.map(b => `B${b}`).join(", ") || "General";
        return {
            id: idx,
            buckets: bucketLabels,
            text: q["QUESTION TEXT"],
            count: deploymentCounts[idx] || 0
        };
    });
    
    // Sort so the most frequently deployed questions show up at the very top
    reportData.sort((a, b) => b.count - a.count);
    
    reportData.forEach(item => {
        const tr = document.createElement("tr");
        const snippet = item.text.length > 90 ? item.text.substring(0, 90) + "..." : item.text;
        
        tr.innerHTML = `
            <td><code>#${item.id}</code></td>
            <td><span class="badge badge-bucket">${item.buckets}</span></td>
            <td title="${item.text.replace(/"/g, '&quot;')}">${snippet}</td>
            <td style="text-align: right; font-weight: bold; color: ${item.count > 0 ? 'var(--navy-yellow)' : 'var(--navy-grey)'};">${item.count}x</td>
        `;
        tbody.appendChild(tr);
    });
}
