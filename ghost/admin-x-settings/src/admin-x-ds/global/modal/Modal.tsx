import Button, {ButtonProps} from '../Button';
import ButtonGroup from '../ButtonGroup';
import ConfirmationModal from './ConfirmationModal';
import Heading from '../Heading';
import NiceModal, {useModal} from '@ebay/nice-modal-react';
import React, {useEffect} from 'react';
import StickyFooter from '../StickyFooter';
import clsx from 'clsx';
import useGlobalDirtyState from '../../../hooks/useGlobalDirtyState';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'bleed' | number;

export interface ModalProps {

    /**
     * Possible values are: `sm`, `md`, `lg`, `xl, `full`, `bleed`. Yu can also use any number to set an arbitrary width.
     */
    size?: ModalSize;

    testId?: string;
    title?: string;
    okLabel?: string;
    okColor?: string;
    cancelLabel?: string;
    leftButtonLabel?: string;
    buttonsDisabled?: boolean;
    footer?: boolean | React.ReactNode;
    noPadding?: boolean;
    onOk?: () => void;
    onCancel?: () => void;
    children?: React.ReactNode;
    backDrop?: boolean;
    backDropClick?: boolean;
    stickyFooter?: boolean;
    scrolling?: boolean;
    dirty?: boolean;
    closeConfrimationTitle?: string;
    closeConfirmationPrompt?: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({
    size = 'md',
    testId,
    title,
    okLabel = 'OK',
    cancelLabel = 'Cancel',
    footer,
    leftButtonLabel,
    buttonsDisabled,
    noPadding = false,
    onOk,
    okColor = 'black',
    onCancel,
    children,
    backDrop = true,
    backDropClick = true,
    stickyFooter = false,
    scrolling = true,
    dirty = false,
    closeConfrimationTitle = 'Are you sure you want to leave this page?',
    closeConfirmationPrompt = (
        <>
            <p>{`Hey there! It looks like you didn't save the changes you made.`}</p>
            <p>Save before you go!</p>
        </>
    )
}) => {
    const modal = useModal();
    const {setGlobalDirtyState} = useGlobalDirtyState();

    useEffect(() => {
        setGlobalDirtyState(dirty);
    }, [dirty, setGlobalDirtyState]);

    let buttons: ButtonProps[] = [];

    const removeModal = () => {
        if (!dirty) {
            modal.remove();
        } else {
            NiceModal.show(ConfirmationModal, {
                title: closeConfrimationTitle,
                prompt: closeConfirmationPrompt,
                okLabel: 'Leave',
                cancelLabel: 'Stay',
                okColor: 'red',
                onOk: (confirmationModal) => {
                    modal.remove();
                    confirmationModal?.remove();
                }
            });
        }
    };

    if (!footer) {
        if (cancelLabel) {
            buttons.push({
                key: 'cancel-modal',
                label: cancelLabel,
                onClick: (onCancel ? onCancel : () => {
                    removeModal();
                }),
                disabled: buttonsDisabled
            });
        }

        if (okLabel) {
            buttons.push({
                key: 'ok-modal',
                label: okLabel,
                color: okColor,
                className: 'min-w-[80px]',
                onClick: onOk,
                disabled: buttonsDisabled
            });
        }
    }

    let modalClasses = clsx(
        'relative z-50 mx-auto flex max-h-[100%] w-full flex-col justify-between overflow-x-hidden rounded bg-white shadow-xl',
        scrolling ? 'overflow-y-auto' : 'overflow-y-hidden'
    );
    let backdropClasses = clsx('fixed inset-0 z-40 h-[100vh] w-[100vw]');

    let padding = '';

    switch (size) {
    case 'sm':
        modalClasses += ' max-w-[480px] ';
        backdropClasses += ' p-[8vmin]';
        padding = 'p-8';
        break;

    case 'md':
        modalClasses += ' max-w-[720px] ';
        backdropClasses += ' p-[8vmin]';
        padding = 'p-8';
        break;

    case 'lg':
        modalClasses += ' max-w-[1020px] ';
        backdropClasses += ' p-[4vmin]';
        padding = 'p-8';
        break;

    case 'xl':
        modalClasses += ' max-w-[1240px] ';
        backdropClasses += ' p-[3vmin]';
        padding = 'p-10';
        break;

    case 'full':
        modalClasses += ' h-full ';
        backdropClasses += ' p-[2vmin]';
        padding = 'p-10';
        break;

    case 'bleed':
        modalClasses += ' h-full ';
        padding = 'p-10';
        break;

    default:
        backdropClasses += ' p-[8vmin]';
        padding = 'p-8';
        break;
    }

    if (noPadding) {
        padding = 'p-0';
    }

    let footerClasses = clsx(
        `${padding} ${stickyFooter ? 'py-6' : 'pt-0'}`,
        'flex w-full items-center justify-between'
    );

    let contentClasses = clsx(
        padding,
        ((size === 'full' || size === 'bleed') && 'grow')
    );

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget && backDropClick) {
            removeModal();
        }
    };

    const modalStyles = (typeof size === 'number') ? {
        width: size + 'px'
    } : {};

    let footerContent;
    if (footer) {
        footerContent = footer;
    } else if (footer === false) {
        contentClasses += ' pb-0 ';
    } else {
        footerContent = (
            <div className={footerClasses}>
                <div>
                    {leftButtonLabel &&
                    <Button label={leftButtonLabel} link={true} />
                    }
                </div>
                <div className='flex gap-3'>
                    <ButtonGroup buttons={buttons}/>
                </div>
            </div>
        );
    }

    footerContent = (stickyFooter ?
        <StickyFooter height={84}>
            {footerContent}
        </StickyFooter>
        :
        <>
            {footerContent}
        </>
    );

    return (
        <div className={backdropClasses} id='modal-backdrop' onClick={handleBackdropClick}>
            <div className={clsx(
                'pointer-events-none fixed inset-0 z-0',
                backDrop && 'bg-[rgba(98,109,121,0.15)] backdrop-blur-[3px]'
            )}></div>
            <section className={modalClasses} data-testid={testId} style={modalStyles}>
                <div className={contentClasses}>
                    <div className='h-full'>
                        {title && <Heading level={4}>{title}</Heading>}
                        {children}
                    </div>
                </div>
                {footerContent}
            </section>
        </div>
    );
};

export default Modal;
